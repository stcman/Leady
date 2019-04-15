var imaps = require('imap-simple');
const util = require('util');
var parser = require('fast-xml-parser');
var he = require('he');
var mysql = require('mysql');
var fs = require('fs');
var cron = require('node-cron');

function extractEmails ( text ){
    return text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
    }

function noSpec(text){
    if(text){
        if(text.includes('=')){
            var test = text.replace('=', ''); //if parsed with '='
            return test.replace(/\s+/g, ''); // remove spaces
        }else{
            return text;
        }
    }
}

function getDateTime() {

    var date = new Date();

    var hour = date.getHours();
    hour = (hour < 10 ? "0" : "") + hour;

    var min  = date.getMinutes();
    min = (min < 10 ? "0" : "") + min;

    var sec  = date.getSeconds();
    sec = (sec < 10 ? "0" : "") + sec;

    var year = date.getFullYear();

    var month = date.getMonth() + 1;
    month = (month < 10 ? "0" : "") + month;

    var day  = date.getDate();
    day = (day < 10 ? "0" : "") + day;

    return `[${year}-${month}-${day} ${hour}:${min}:${sec}]`

}

    var config = {
        imap: {
            user: 'billsonjenkins@gmail.com',
            password: 'cookies24',
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            authTimeout: 3000
        }
    };
     
    imaps.connect(config).then(function (connection) {
     
        return connection.openBox('INBOX').then(function () {
            var searchCriteria = [
                'UNSEEN'
            ];
     
            var fetchOptions = {
                bodies: ['HEADER', 'TEXT'],
                markSeen: true
            };
     
            return connection.search(searchCriteria, fetchOptions).then(function (results) {
                var EmailContent = results.map(function (res) {
                    return res.parts.filter(function (part) {
                        return part.which === 'TEXT';
                    })[0].body;
                });
     
    
                var xmlData = `${EmailContent}`; //xml data from email
    
                xmlData = xmlData ? xmlData.replace(/=\r?\n|\r/g, '') : '';
    
                if(xmlData.includes('</adf>') === false && xmlData !== ''){ //if not XML adf document
                    fs.appendFile('leadRetrieverErrors.log', `\nERROR ${getDateTime()} BAD REQUEST - The Document is not XML adf. \n${xmlData}`, function (err) {
                        if (err) throw err;
                      });
                }else if(xmlData.includes('</adf>')){   
                var xmlData = xmlData.split('<adf>'); //divide requests
                var numReq = xmlData.length;
                var xmlReqs;
                var arrJsonObjs = [];
    
                for(i = 1; i < numReq; i++){
                    xmlReqs = `<adf>${xmlData[i]}`; //append back on split off '<adf>' tag
    
                    // XML Parser
    
                    var options = {
                        attributeNamePrefix : "@_",
                        attrNodeName: "attr", //default is 'false'
                        textNodeName : "#text",
                        ignoreAttributes : true,
                        ignoreNameSpace : false,
                        allowBooleanAttributes : false,
                        parseNodeValue : true,
                        parseAttributeValue : false,
                        trimValues: true,
                        cdataTagName: "__cdata", //default is 'false'
                        cdataPositionChar: "\\c",
                        localeRange: "", //To support non english character in tag/attribute values.
                        parseTrueNumberOnly: false,
                        attrValueProcessor: a => he.decode(a, {isAttributeValue: true}),//default is a=>a
                        tagValueProcessor : a => he.decode(a) //default is a=>a
                    };
                     
                    if( parser.validate(xmlReqs) === true) { //optional (it'll return an object in case it's not valid)
                        var jsonObj = parser.parse(xmlReqs,options);
                    }
                     
                    // Intermediate obj
                    var tObj = parser.getTraversalObj(xmlReqs,options);
                    var jsonObj = parser.convertToJson(tObj,options);
    
                    arrJsonObjs.push(jsonObj); //push each parsed json request into array
    
                }

                var con = mysql.createConnection({ //connect to sql DB
                    host: "localhost",
                    user: "root",
                    password: "cookies24",
                    database: "leadsDB"
                });

                fs.appendFile('leadRetrieverErrors.log', `\nALERT ${getDateTime()} Connected!`, function (err) {
                    if (err) throw err;
                  });
    
                arrJsonObjs.forEach(eachJObj => {  // loop over each request obejct and extract data
    
                    var leadData = {};
                    var ProviderName = '';
    
                    if(eachJObj.adf.prospect.customer.contact.provider){
                            if(typeof eachJObj.adf.prospect.customer.contact.provider.name === "string"){
                                ProviderName = noSpec(eachJObj.adf.prospect.customer.contact.provider.name);
                            }
                        if(eachJObj.adf.prospect.customer.contact.provider.name === 'Vicimus'){
                        leadData.name = eachJObj.adf.prospect.customer.contact.name.join(' ');
                        leadData.email = eachJObj.adf.prospect.customer.contact.email['#text'] ? eachJObj.adf.prospect.customer.contact.email['#text'] : eachJObj.adf.prospect.customer.contact.email;
                        leadData.email = extractEmails(leadData.email)[0];
                        leadData.phone = eachJObj.adf.prospect.customer.contact.phone;
                        leadData.carMake = eachJObj.adf.prospect.vehicle.make;
                        leadData.carMod = eachJObj.adf.prospect.vehicle.model;
                        leadData.carYear =eachJObj.adf.prospect.vehicle.year;
                        leadData.carPrice = eachJObj.adf.prospect.vehicle.price;
                        }
                    }else if(eachJObj.adf.prospect.vendor.provider){
                        if(typeof eachJObj.adf.prospect.vendor.provider.name.__cdata === "string"){
                            ProviderName = noSpec(eachJObj.adf.prospect.vendor.provider.name.__cdata) + `v2`;
                        }
    
                        if(ProviderName === 'Dealer.comv2'){
                            leadData.name = `${eachJObj.adf.prospect.customer.contact.name[0].__cdata} ${eachJObj.adf.prospect.customer.contact.name[1].__cdata}`;
                            leadData.email = extractEmails(eachJObj.adf.prospect.customer.contact.email.__cdata);
                            leadData.phone = eachJObj.adf.prospect.customer.contact.phone ? eachJObj.adf.prospect.customer.contact.phone.__cdata : ''; //if <phone\> tag exists in <customer\>
                            leadData.carMake = eachJObj.adf.prospect.vehicle.make.__cdata;
                            leadData.carMod = eachJObj.adf.prospect.vehicle.model.__cdata;
                            leadData.carYear =eachJObj.adf.prospect.vehicle.year.__cdata;
                            leadData.carPrice = eachJObj.adf.prospect.vehicle.price;
                        }
                    }else{
                            if(eachJObj.adf.prospect.pro){ //kijiji lead parse fail
                                ProviderName = noSpec(eachJObj.adf.prospect.pro.name);
                            }else if(typeof eachJObj.adf.prospect.provider.name.__cdata === "string"){
                                ProviderName = noSpec(eachJObj.adf.prospect.provider.name.__cdata);
                            }else if(typeof eachJObj.adf.prospect.provider.name === "string"){
                                ProviderName = noSpec(eachJObj.adf.prospect.provider.name);
                            }
                        if(ProviderName === 'Vicimus'){ //ver1
                            leadData.name = eachJObj.adf.prospect.customer.contact.name.join(' ');
                            leadData.email = eachJObj.adf.prospect.customer.contact.email['#text'] ? eachJObj.adf.prospect.customer.contact.email['#text'] : eachJObj.adf.prospect.customer.contact.email;
                            leadData.email = extractEmails(leadData.email)[0];
                            leadData.phone = eachJObj.adf.prospect.customer.contact.phone;
                            leadData.carMake = eachJObj.adf.prospect.vehicle.make;
                            leadData.carMod = eachJObj.adf.prospect.vehicle.model;
                            leadData.carYear =eachJObj.adf.prospect.vehicle.year;
                            leadData.carPrice = eachJObj.adf.prospect.vehicle.price;
                        }else if(ProviderName === 'Dealer.com'){ //ver2
                            leadData.name = `${eachJObj.adf.prospect.customer.contact.name[0].__cdata} ${eachJObj.adf.prospect.customer.contact.name[1].__cdata}`;
                            leadData.email = extractEmails(eachJObj.adf.prospect.customer.contact.email.__cdata);
                            leadData.phone = eachJObj.adf.prospect.customer.contact.phone ? eachJObj.adf.prospect.customer.contact.phone.__cdata : ''; //if <phone\> tag exists in <customer\>
                            leadData.carMake = eachJObj.adf.prospect.vehicle.make.__cdata;
                            leadData.carMod = eachJObj.adf.prospect.vehicle.model.__cdata;
                            leadData.carYear =eachJObj.adf.prospect.vehicle.year.__cdata;
                            leadData.carPrice = eachJObj.adf.prospect.vehicle.price;
                        }else if(ProviderName === 'Auto Trader Email' || ProviderName === 'Trader Mobile Email' || ProviderName === 'Auto Trader Email New Car' || ProviderName === 'Auto Trader Email - ICO - Trade-In' || ProviderName === 'Trader Mobile Text' || ProviderName === 'Auto Trader Mobile'){
                            leadData.name = eachJObj.adf.prospect.customer.contact.name.__cdata;
                            leadData.email = extractEmails(eachJObj.adf.prospect.customer.contact.email.__cdata);
                            leadData.phone = eachJObj.adf.prospect.customer.contact.phone.__cdata;
                            leadData.carMake = eachJObj.adf.prospect.vehicle.make.__cdata;
                            leadData.carMod = eachJObj.adf.prospect.vehicle.model.__cdata;
                            leadData.carYear =eachJObj.adf.prospect.vehicle.year.__cdata;
                            leadData.carPrice = eachJObj.adf.prospect.vehicle.price.__cdata;
                        }
                    }
    
    
                    if((Object.entries(leadData).length === 0 && leadData.constructor === Object) !== true){ //if leadData obj not empty

                        var sql = `INSERT INTO customers (name, email_address, phone, make, model, year, price) VALUES ('${leadData.name}', '${leadData.email}', '${leadData.phone}', '${leadData.carMake}', '${leadData.carMod}', '${leadData.carYear}', '${leadData.carPrice}')`;
                        con.query(sql, function (err, result) {
                        if (err) throw err;
                        });
                    }else{
                        fs.appendFile('leadRetrieverErrors.log', `\nERROR ${getDateTime()} BAD REQUEST - Could not capture lead as the provider name "${ProviderName}" is unknown.`, function (err) { //log
                            if (err) throw err;
                          });
                    }
                    })

                    con.end(function(err) {
                        fs.appendFile('leadRetrieverErrors.log', `\nALERT ${getDateTime()} Disconnected!`, function (err) {
                            if (err) throw err;
                          });
                        if(err) {
                            console.log(err.message);
                        }
                    });
                }    
            });
        });
    });
 

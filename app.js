module.exports = function(){

    var express = require('express');
    var cookieParser = require('cookie-parser');
    var bodyParser = require('body-parser');
    var app = express();
    var mongoose = require('./config/db.js')();
    var passport = require('passport');
    var redis = require('redis');
    var CronJob = require('cron').CronJob;
    var Q = require('q');  

    global.keys = require('./config/keys.js'); 

    app.use(cookieParser());
    app.use(require('express-session')({
        key: 'session',
        resave: false, //does not forces session to be saved even when unmodified
        saveUninitialized: true, //forces a session that is "uninitialized"(new but unmodified) to be saved to the store
        secret: 'azuresample',
        store: require('mongoose-session')(mongoose),
        cookie:{maxAge:8640000}// for 1 day
    }));

    global.redisClient = redis.createClient(global.keys.redisPort,
        global.keys.redisURL,
        {
            auth_pass:global.keys.redisPassword
        }
    );

    //models. 
    var Project = require('./model/project.js')(mongoose);
    var Subscriber = require('./model/subscriber.js')(mongoose);
    var User = require('./model/user.js')(mongoose);
    var Table = require('./model/table.js')(mongoose);
    var ProjectDetails = require('./model/projectDetails.js')(mongoose);
    var StripeCustomer = require('./model/stripeCustomer.js')(mongoose);
    var CreditCardInfo = require('./model/creditCardInfo.js')(mongoose);
    var Invoice = require('./model/invoice.js')(mongoose);
    var InvoiceSettings = require('./model/invoiceSettings.js')(mongoose);


    //config
    require('./config/cors.js')(app);
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded());
    app.use(cookieParser('azuresample'));
    app.use(passport.initialize());
    app.use(passport.session());
    require('./framework/config')(passport, User);

    //services.
    var UserService = require('./services/userService')(User);
    var SubscriberService  = require('./services/subscriberService.js')(Subscriber);
    var InvoiceService  = require('./services/invoiceService.js')(Invoice,InvoiceSettings,UserService);
    var ProjectService  = require('./services/projectService.js')(Project,InvoiceService);
    var TableService  = require('./services/tableService.js')(Table);
    var ProjectDetailsService  = require('./services/projectDetailsService.js')(ProjectDetails);
    var PaymentService  = require('./services/paymentService.js')(StripeCustomer,CreditCardInfo,InvoiceService,UserService,ProjectService);   


    //routes. 
    app.use('/auth', require('./routes/auth')(passport,UserService));
    app.use('/', require('./routes/subscriber.js')(SubscriberService));
    app.use('/', require('./routes/project.js')(ProjectService));
    app.use('/', require('./routes/table.js')(TableService));
    app.use('/', require('./routes/projectDetails.js')(ProjectDetailsService));
    app.use('/', require('./routes/payment.js')(PaymentService));
    app.use('/', require('./routes/invoice.js')(InvoiceService));


    app.get('/', function(req, res, next){
        res.send(200, 'Frontend Service is up and running fine.');
    });



    /**********CRON JOB**********/
    try {

        var job = new CronJob('00 30 11 1 * *', function() {
          /*
           * 00 30 11 1 * *
           * Runs every Month 1st day on weekday (Sunday through Saturday)
           * at 11:30:00 AM. 
           */
            
            InvoiceService.getDueInvoiceList().then(function(invoiceList){                                    
              if(invoiceList){
                    
                    var userIndex=[]; 
                    var promises=[]; 

                    for(var i=0;i<invoiceList.length;++i){

                      var userId=invoiceList[i]._userId;                    

                      if(!invoiceList[i].charged){//if previously not charged
                         promises.push(PaymentService.findCard(userId));
                         userIndex.push(i);
                      }                      
                    }

                    Q.allSettled(promises).then(function(creditCardList){                
                  
                        for(var i=0;i<creditCardList.length;i++){                            
                      
                            if(creditCardList[i].state="fulfilled" && creditCardList[i].value){                               
                                var index=userIndex[i];
                                var customerId=creditCardList[i].value.stripeCardObject.customer;
                               
                                //make payments
                                PaymentService.makePayments(invoiceList[index],customerId);                                                                                   

                            }else{//if card not found block the user                                                       
                                var index=userIndex[i];
                                InvoiceService.blockUser(invoiceList[index]._userId,invoiceList[index]._appId);
                            }                   
                        }             

                    });//end of Q.allSetteled

              }else{
                console.log("There are no Invoices.");
              }

            },function(error){
              console.log(error);              
            });//end of getting invoice List

          }, function () {
            /* This function is executed when the job stops */
          },
          true /* Start the job right now */           
        );
        job.start();

    } catch(ex) {
        console.log("cron pattern not valid");
    }   
    /**********CRON JOB**********/   

    return app;
};


var path       = require("path"),
    util       = require("util"),
    iwlist     = require("./iwlist"),
    express    = require("express"),
    bodyParser = require('body-parser'),
    config     = require("../config.json"),
    log4js     = require("log4js"),
    http_test  = config.http_test_only;

var logger = log4js.getLogger();

log4js.configure({
	appenders: [
		{ type: 'console' },
		{ type: 'file', filename: 'prism-connector.log', category: 'connector' },
	]
});


// Helper function to log errors and send a generic status "SUCCESS"
// message to the caller
function log_error_send_success_with(success_obj, error, response) {
    if (error) {
        logger.error(error);
        response.send({ status: "ERROR", error: error });
    } else {
        success_obj = success_obj || {};
        success_obj["status"] = "SUCCESS";
        response.send(success_obj);
		logger.debug("Success sent : " + JSON.stringify(success_obj));
    }
    response.end();
}

function redirectUnmatched(req, res) {
	var redirectUrl = config.access_point.ip_addr + ':' + config.server.port + '/';
	logger.debug("Redirecting client from '" + req.originalUrl + "' to '" + redirectUrl + "'.");
    res.redirect('/');
}

/*****************************************************************************\
    Returns a function which sets up the app and our various routes.
\*****************************************************************************/
module.exports = function(wifi_manager, callback) {
    var app = express();

    // Configure the app
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));
    app.set("trust proxy", true);

    // Setup static routes to public assets
    app.use(express.static(path.join(__dirname, "public")));
    app.use(bodyParser.json());

    // Setup HTTP routes for rendering views
    app.get("/", function(request, response) {
        response.render("index");
    });

    // Setup HTTP routes for various APIs we wish to implement
    // the responses to these are typically JSON
    app.get("/api/rescan_wifi", function(request, response) {
        logger.info("Server got /rescan_wifi");
        iwlist(function(error, result) {
            log_error_send_success_with(result[0], error, response);
        });
    });

    app.post("/api/enable_wifi", function(request, response) {
        var conn_info = {
            wifi_ssid:      request.body.wifi_ssid,
            wifi_passcode:  request.body.wifi_passcode,
        };

        // TODO: If wifi did not come up correctly, it should fail
        // currently we ignore ifup failures.
        wifi_manager.enable_wifi_mode(conn_info, function(error) {
            if (error) {
                logger.error("Enable Wifi ERROR: " + error);
                logger.info("Attempt to re-enable AP mode");
                wifi_manager.enable_ap_mode(config.access_point.ssid, function(error) {
                    logger.info("... AP mode reset");
                });
                response.redirect("/");
            }
            // Success! - exit
            logger.info("Wifi Enabled! - Exiting");
            process.exit(0);
        });
    });

    app.all('*', redirectUnmatched);

    // Listen on our server
    app.listen(config.server.port);
}

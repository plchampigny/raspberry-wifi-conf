var _       = require("underscore")._,
    async   = require("async"),
    fs      = require("fs"),
    exec    = require("child_process").exec,
    log4js  = require("log4js"),
    config  = require("../config.json");
 

var logger = log4js.getLogger();
log4js.configure({
	appenders: [
		{ type: 'console' },
		{ type: 'file', filename: 'prism-connector.log', category: 'connector' },
	]
});

// Better template format
_.templateSettings = {
    interpolate: /\{\{(.+?)\}\}/g,
    evaluate :   /\{\[([\s\S]+?)\]\}/g
};

// Helper function to write a given template to a file based on a given
// context
function write_template_to_file(template_path, file_name, context, callback) {
    async.waterfall([

        function read_template_file(next_step) {
            fs.readFile(template_path, {encoding: "utf8"}, next_step);
        },

        function update_file(file_txt, next_step) {
            var template = _.template(file_txt);
            fs.writeFile(file_name, template(context), next_step);
        }

    ], callback);
}
// DEl file
function del_config_file(file_name, callback) {
    async.waterfall([

        function del_file(next_step) {
          logger.info("... Going to delete an existing file");
          fs.unlink(file_name, next_step);
        }
    ], callback);
}

/*****************************************************************************\
    Return a set of functions which we can use to manage and check our wifi
    connection information
\*****************************************************************************/
module.exports = function() {
    // Detect which wifi driver we should use, the rtl871xdrv or the nl80211
    exec("sudo iw list", function(error, stdout, stderr) {
        if (stderr.match(/^nl80211 not found/)) {
            config.wifi_driver_type = "rtl871xdrv";
        }
        // logger.info("config.wifi_driver_type = " + config.wifi_driver_type);
    });

    // Hack: this just assumes that the outbound interface will be "wlan0"

    // Define some globals
    var ifconfig_fields = {
        "hw_addr":         /HWaddr\s([^\s]+)/,
        "inet_addr":       /inet addr:([^\s]+)/,
    },  iwconfig_fields = {
        "ap_addr":         /Access Point:\s([^\s]+)/,
        "ap_ssid":         /ESSID:\"([^\"]+)\"/,
        "unassociated":    /(unassociated)\s+Nick/,
    },  last_wifi_info = null;

    // TODO: rpi-config-ap hardcoded, should derive from a constant

    // Get generic info on an interface
    var _get_wifi_info = function(callback) {
        var output = {
            hw_addr:      "<unknown>",
            inet_addr:    "<unknown>",
            unassociated: "<unknown>",
        };

        // Inner function which runs a given command and sets a bunch
        // of fields
        function run_command_and_set_fields(cmd, fields, callback) {
            exec(cmd, function(error, stdout, stderr) {
                if (error) return callback(error);
                for (var key in fields) {
                    re = stdout.match(fields[key]);
                    if (re && re.length > 1) {
                        output[key] = re[1];
                    }
                }
                callback(null);
            });
        }

        // Run a bunch of commands and aggregate info
        async.series([
            function run_ifconfig(next_step) {
                run_command_and_set_fields("sudo ifconfig wlan0", ifconfig_fields, next_step);
            },
            function run_iwconfig(next_step) {
                run_command_and_set_fields("sudo iwconfig wlan0", iwconfig_fields, next_step);
            },
        ], function(error) {
            last_wifi_info = output;
            return callback(error, output);
        });
    },

    _reboot_wireless_network = function(wlan_iface, callback) {
        async.series([
            function down(next_step) {
                exec("sudo ifdown " + wlan_iface, function(error, stdout, stderr) {
                    if (!error) logger.info("ifdown " + wlan_iface + " successful...");
                    next_step();
                });
            },
            function up(next_step) {
                exec("sudo ifup " + wlan_iface, function(error, stdout, stderr) {
                    if (!error) logger.info("ifup " + wlan_iface + " successful...");
                    next_step();
                });
            },
        ], callback);
    },

    // Wifi related functions
    _is_wifi_enabled_sync = function(info) {
        // If we are not an AP, and we have a valid
        // inet_addr - wifi is enabled!
        if (null        == _is_ap_enabled_sync(info) &&
            "<unknown>" != info["inet_addr"]         &&
            "<unknown>" == info["unassociated"] ) {
            return info["inet_addr"];
        }
        return null;
    },

    _is_wifi_enabled = function(callback) {
        _get_wifi_info(function(error, info) {
            if (error) return callback(error, null);
            return callback(null, _is_wifi_enabled_sync(info));
        });
    },

    // Access Point related functions
    _is_ap_enabled_sync = function(info) {
        // If the hw_addr matches the ap_addr
        // and the ap_ssid matches "rpi-config-ap"
        // then we are in AP mode
        if (info["ap_ssid"] === null || info["ap_ssid"] === undefined){
          info["ap_ssid"] = config.access_point.ssid
        }
        if (info["ap_addr"] === null || info["ap_addr"] === undefined || info["ap_addr"] == 'Not-Associated'){
          info["ap_addr"] = info["hw_addr"]
        }
        var is_ap  =
            info["hw_addr"] == info["ap_addr"] &&
            info["ap_ssid"] == config.access_point.ssid;

        return (is_ap) ? info["hw_addr"].toLowerCase() : null;
    },

    _is_ap_enabled = function(callback) {
        _get_wifi_info(function(error, info) {
            if (error) return callback(error, null);
            return callback(null, _is_ap_enabled_sync(info));
        });
    },

    // Enables the accesspoint w/ bcast_ssid. This assumes that both
    // dnsmasq and hostapd are installed using:
    // $sudo npm run-script provision
    _enable_ap_mode = function(bcast_ssid, callback) {
        _is_ap_enabled(function(error, result_addr) {
            if (error) {
                logger.info("ERROR: " + error);
                return callback(error);
            }

            if (result_addr && !config.access_point.force_reconfigure) {
                logger.info("\nAccess point is enabled with ADDR: " + result_addr);
                return callback(null);
            } else if (config.access_point.force_reconfigure) {
                logger.info("\nForce reconfigure enabled - reset AP");
            } else {
                logger.info("\nAP is not enabled yet... enabling...");
            }

            var context = config.access_point;
            context["enable_ap"] = true;
            context["wifi_driver_type"] = config.wifi_driver_type;

            // Here we need to actually follow the steps to enable the ap
            async.series([

                // Enable the access point ip and netmask + static
                // DHCP for the wlan0 interface
                function update_interfaces(next_step) {
                    write_template_to_file(
                        "./assets/etc/network/interfaces.ap.template",
                        "/etc/network/interfaces",
                        context, next_step);
                },

                // Enable DHCP conf, set authoritative mode and subnet
                function update_dhcpcd(next_step) {
                    var context = config.access_point;
                    // We must enable this to turn on the access point
                    write_template_to_file(
                        "./assets/etc/dhcp/dhcpcd.conf.template",
                        "/etc/dhcpcd.conf",
                        context, next_step);
                },

                // Enable the interface in the dhcp server
                function update_dns_interface(next_step) {
                    write_template_to_file(
                        "./assets/etc/dnsmasq/dnsmasq.conf.template",
                        "/etc/dnsmasq.conf",
                        context, next_step);
                },

                // Enable hostapd.conf file
                function update_hostapd_conf(next_step) {
                    write_template_to_file(
                        "./assets/etc/hostapd/hostapd.conf.template",
                        "/etc/hostapd/hostapd.conf",
                        context, next_step);
                },

                function update_hostapd_default(next_step) {
                    write_template_to_file(
                        "./assets/etc/default/hostapd.template",
                        "/etc/default/hostapd",
                        context, next_step);
                },

                function reboot_network_interfaces(next_step) {
                    _reboot_wireless_network(context.wifi_interface, next_step);
                },

                function restart_dhcp_service(next_step) {
                    exec("service dhcpcd restart", function(error, stdout, stderr) {
                        //logger.info(stdout);
                        if (!error) logger.info("... dhcpcd server restarted!");
                        next_step();
                    });
                },

                function restart_dns_service(next_step) {
                    exec("service dnsmasq restart", function(error, stdout, stderr) {
                        //logger.info(stdout);
                        if (!error) logger.info("... dnsmasq server restarted!");
                        next_step();
                    });
                },

                function restart_hostapd_service(next_step) {
                    exec("service hostapd restart", function(error, stdout, stderr) {
                        //logger.info(stdout);
                        if (!error) logger.info("... hostapd restarted!");
                        next_step();
                    });
                },

                // TODO: Do we need to issue a reboot here?

            ], callback);
        });
    },

    // Disables AP mode and reverts to wifi connection
    _enable_wifi_mode = function(connection_info, callback) {

        _is_wifi_enabled(function(error, result_ip) {
            if (error) return callback(error);

            if (result_ip) {
                logger.info("\nWifi connection is enabled with IP: " + result_ip);
                return callback(null);
            }

            async.series([

                //
                function del_hostapd(next_step) {
                    del_config_file(
                        "/etc/hostapd/hostapd.conf",
                        next_step);
                },

                function update_dhcpcd(next_step) {
                    write_template_to_file(
                        "./assets/etc/default/dhcpcd.conf",
                        "/etc/dhcpcd.conf",
                        connection_info, next_step);
                },

                // Update /etc/network/interface with correct info...
                function update_dhcp(next_step) {
                    write_template_to_file(
                        "./assets/etc/network/interfaces.wifi.template",
                        "/etc/network/interfaces",
                        connection_info, next_step);
                },

                // Update /etc/network/interface with correct info...
                function update_wpa(next_step) {
                    write_template_to_file(
                        "./assets/etc/wpa_supplicant/wpa_supplicant.conf.template",
                        "/etc/wpa_supplicant/wpa_supplicant.conf",
                        connection_info, next_step);
                },

                // Stop the DHCP server...
                function restart_dhcp_service(next_step) {
                    exec("service dnsmasq stop", function(error, stdout, stderr) {
                        //logger.info(stdout);
                        if (!error) logger.info("... dhcp server stopped!");
                        next_step();
                    });
                },

                // Stop the hostapd server...
                function restart_hostapd_service(next_step) {
                    exec("service hostapd stop", function(error, stdout, stderr) {
                        //logger.info(stdout);
                        if (!error) logger.info("... hostapd stop!");
                        next_step();
                    });
                },


                function reboot_network_interfaces(next_step) {
                    _reboot_wireless_network(config.wifi_interface, next_step);
                },

            ], callback);
        });

    };

    return {
        get_wifi_info:           _get_wifi_info,
        reboot_wireless_network: _reboot_wireless_network,

        is_wifi_enabled:         _is_wifi_enabled,
        is_wifi_enabled_sync:    _is_wifi_enabled_sync,

        is_ap_enabled:           _is_ap_enabled,
        is_ap_enabled_sync:      _is_ap_enabled_sync,

        enable_ap_mode:          _enable_ap_mode,
        enable_wifi_mode:        _enable_wifi_mode,
    };
}

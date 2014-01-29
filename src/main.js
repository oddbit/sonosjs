/** ---------------------------------------------------------------------------
 *  SonosJS
 *  Copyright 2013 Dennis Alund
 *  http://github.com/oddbit/sonosjs
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * ------------------------------------------------------------------------- */

define(function (require) {
        "use strict";

        require("sugar");
        var log = require("log");
        var env = require("utils/environment");
        var event = require("utils/event");
        var net = require("net");
        var ssdp = require("ssdp");
        var soap = require("soap");
        var models = require("models");

        // Refresh the device list after maximum five minutes
        var deviceMaxLifetime = 1000 * 60 * 5;

        /**
         * The public API for Sonos service.
         * There is only a single instance of the sonos service in the module.
         *
         * @returns {object} Sonos service
         */
        function sonosService() {
            var that = {};

            var isServiceRunning = false;
            var multicastGroupSocket;
            var devices = {};

            /**
             * Start up the UPnP controller
             * Join the SSDP multicast group and start receiving notifications.
             */
            that.start = function () {
                if (!net.haveSocketSupport) {
                    log.error("No socket support. Can not run Sonos controller.");
                    return;
                }

                log.info("Starting the Sonos UPnP controller");
                isServiceRunning = true;
                if (multicastGroupSocket && !multicastGroupSocket.isClosed()) {
                    return;
                }

                multicastGroupSocket = net.udpSocket({
                    remoteIp: "239.255.255.250",
                    localPort: 1900,
                    consumer: onMulticastNotification
                });


                multicastGroupSocket.open(function () {
                    multicastGroupSocket.joinMulticast();
                });

                // Just send out whatever we got to start with
                event.trigger(event.action.DEVICES, getDevices());

                // Go wild with discovery at startup!
                discover();
                setTimeout(discover, 3000);
                setTimeout(discover, 10000);
            };

            /**
             * Shut down the UPnP controller
             * Leave the SSDP multicast group.
             */
            that.stop = function () {
                log.info("Stopping the Sonos UPnP controller");
                isServiceRunning = false;
                if (!multicastGroupSocket || multicastGroupSocket.isClosed()) {
                    return;
                }
                multicastGroupSocket.close();
            };

            /**
             * Get the current device data
             *
             * @returns {object} Device data
             */
            that.getDevices = function () {
                return getDevices();
            };

            /**
             * Request a specific device's details by its id or a known URL to description service.
             *
             * This method will trigger corresponding information event when the device responds to the request
             *
             * @param {string} info     A device id or an URL to the device's service
             */
            that.requestDeviceDetails = function (info) {
                var location = null;
                if (typeof(info) === "string") {
                    if (devices.hasOwnProperty(info)) {
                        location = devices[info].getInfoUrl();

                    }
                    else {
                        location = info;
                    }
                }

                if (location !== null) {
                    requestDeviceDetails(location);
                }
            };

            /**
             * Make a http request to a sonos device and ask for the current media state (i.e. what song
             * is currently playing).
             *
             * This method will trigger corresponding information event when the device responds to the request
             *
             * @param {string} deviceId     Id of the device to inquire
             */
            that.requestMediaState = function (deviceId) {
                var device = null;
                if (typeof(deviceId) === "string" && devices.hasOwnProperty(deviceId)) {
                    device = devices[deviceId];
                }
                log.debug("Requesting media state for device: %s", deviceId);

                if (device === null) {
                    log.warning("No device in cache with id: %s", deviceId);
                }

                net.soapRequest(
                    device.getMediaStateUrl(),
                    soap.mediaInfo(),
                    function soapMediaInfoCallback(xml) {
                        var mediaInfo = models.mediaInfo.fromXml(xml);
                        if (mediaInfo) {
                            event.trigger(event.action.MEDIA_INFO, mediaInfo);
                        }
                        else {
                            log.error("Had problems to parse media info XML.", xml);
                        }
                    }
                );
            };

            // ----------------------------------------------------------------
            // ----------------------------------------------------------------
            // PRIVATE METHODS

            function getDevices() {
                var deviceList = [];
                for (var deviceId in devices) {
                    if (devices.hasOwnProperty(deviceId)) {
                        deviceList.push(devices[deviceId]);
                    }
                }
                return deviceList;
            }


            function removeDevice(deviceId) {
                if (devices.hasOwnProperty(deviceId)) {
                    delete(devices[deviceId]);
                    event.trigger(event.action.DEVICES, getDevices());
                }
            }

            function addDevice(device) {
                var isNew = !devices.hasOwnProperty(device.id);
                devices[device.id] = device;
                if (isNew) {
                    log.debug("Added new device: %s", device.id);
                    event.trigger(event.action.DEVICES, getDevices());
                }
                else {
                    log.debug("Updating device: %s", device.id);
                }
            }

            /**
             * Clean up and refresh the device list cache
             *
             * If a device has not sent any updated info lately (within the specified max cache time);
             * the device will be deleted from the cache and a new request for info will be sent. Naturally
             * it will disappear from the list of devices in case that device does not answer anymore.
             */
            function manageDeviceDecay() {
                var referenceTime = Date.now() - deviceMaxLifetime;

                for (var deviceId in devices) {
                    if (devices.hasOwnProperty(deviceId)) {
                        if (devices[deviceId].getLastUpdated() <= referenceTime) {
                            var url = devices[deviceId].getInfoUrl();
                            removeDevice(deviceId);
                            requestDeviceDetails(url);
                        }
                    }
                }
            }

            /**
             * Contact known device from SSDP for detailed information
             *
             *  @param location
             */
            function requestDeviceDetails(location) {
                log.debug("Making device details request for: %s", location);
                net.httpRequest(
                    location,
                    function xhrCallback(xml) {
                        var device = models.device.fromXml(xml);
                        device.setInfoUrl(location);
                        addDevice(device);
                    }
                );
                setTimeout(manageDeviceDecay, deviceMaxLifetime);
            }

            /**
             * This function is called for each response that is received after explicitly making a SSDP search request.
             *
             * @param {string} data     SSDP discovery response
             */
            function onDiscoveryResponse(data) {
                var discoveryResponse = ssdp.discoveryResponse.fromData(data);
                if (!discoveryResponse) {
                    return;
                }

                // Discovery requests are usually sent in bursts. Multiple responses are expected.
                if (!devices.hasOwnProperty(discoveryResponse.getId())) {
                    requestDeviceDetails(discoveryResponse.location);
                }
            }

            /**
             * This function is called for each SSDP notification that is received in the SSDP multicast group. This can
             * happen at any time without any explicit action from the service.
             *
             * @param {string} data     SSDP notification
             */
            function onMulticastNotification(data) {
                var notification = ssdp.notification.fromData(data);

                if (!notification) {
                    return;
                }

                log.debug("Got a notification message: %s", notification.advertisement);

                var deviceId = notification.getId();

                switch (notification.advertisement) {
                case ssdp.advertisementType.goodbye:
                    removeDevice(deviceId);
                    break;
                case ssdp.advertisementType.alive:
                case ssdp.advertisementType.update:
                    requestDeviceDetails(notification.location);
                    break;
                default:
                    log.error("Unknown advertisement type '%s'", notification.advertisement);
                }
            }

            /**
             * Discover Sonos devices on the network
             *
             * TODO: Send it periodically according to CACHE-CONTROL max age spec
             */
            function discover() {
                log.info("Sending discovery on Sonos UPnP controller");

                var discoveryMessage = ssdp.discoveryRequest({
                    targetScope: "urn:schemas-upnp-org:device:ZonePlayer:1",
                    maxWaitTime: 5
                });

                // UPnP protocol spec says that a client can wait up to the max wait time before having to answer
                // Add a couple of seconds before closing the socket seems to be a good idea
                var socket = net.udpSocket({
                    remoteIp: "239.255.255.250",
                    remotePort: 1900,
                    timeout: 30,
                    consumer: onDiscoveryResponse
                });

                socket.open(function () {
                    // Send each discovery request a number of times in hope that all devices are reached
                    var data = discoveryMessage.toData();
                    [0, 1, 2, 3].forEach(function (time) {
                        setTimeout(function () {
                            log.debug("Sending discovery request %d", time);
                            socket.send(data);
                        }, time * 500);
                    });
                });
            }

            return that;
        }

        return {
            VERSION: env.VERSION,
            event: event,
            models: models,
            service: sonosService()
        };
    }

)
;

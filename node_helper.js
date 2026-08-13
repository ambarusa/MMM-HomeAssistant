"use strict";
const { exec } = require("child_process");
const NodeHelper = require("node_helper");
const Log = require("logger");
const mqtt = require("mqtt");
const puppeteer = require("puppeteer");
const si = require("systeminformation");
// const Gpio = require('onoff').Gpio;

module.exports = NodeHelper.create({
	start () {
		Log.info("Module started");
		this.clients = {};

		this.config = null;
		this.modules = null;

		this.stateTopic = null;
		this.setTopic = null;
		this.availabilityTopic = null;

		this.monitorValue = "unknown";
		this.brightnessValue = 0;

		const nsp = this.io.of("/MMM-HomeAssistant");
		nsp.on("connection", (socket) => {
			Log.debug("Socket connected:", socket.id);
			this.clients[socket.id] = true;

			socket.on("disconnect", () => {
				Log.debug("Socket disconnected:", socket.id);
				delete this.clients[socket.id];
				if (Object.keys(this.clients).length === 0) {
					// No clients connected, disconnect from MQTT
					if (this.client) {
						Log.debug("No clients connected, disconnecting from MQTT");
						this.client.end();
						this.client = null;
					}
				}
			});
		});
	},

	normalizeMqttServer (serverUrl) {
		if (!serverUrl) return serverUrl;
		if (!(/^mqtt(s)?:\/\//).test(serverUrl)) {
			return `mqtt://${serverUrl}`;
		}
		return serverUrl;
	},

	connectMQTT () {
		if (this.client) return;

		if (!this.config || !this.config.mqttServer) {
			throw new Error("MQTT server URL is missing in the configuration.");
		}

		const mqttServer = this.normalizeMqttServer(this.config.mqttServer);

		const mqttOptions = {
      		clientId: this.config.deviceName || `MagicMirror_${Math.random().toString(16).substr(2, 8)}`,
			username: this.config.username || undefined,
			password: this.config.password || undefined,
			port: this.config.mqttPort || 1883, // Default MQTT port
			will: {
				topic: this.availabilityTopic,
				payload: "offline",
				retain: true,
				qos: 1
			}
		};

		// Remove undefined properties for anonymous authentication
		if (!mqttOptions.username) delete mqttOptions.username;
		if (!mqttOptions.password) delete mqttOptions.password;

		Log.debug("Connecting to MQTT server", {
			server: `${mqttServer}:${mqttOptions.port}`,
			clientId: mqttOptions.clientId,
			availabilityTopic: this.availabilityTopic
		});
		this.client = mqtt.connect(mqttServer, mqttOptions);

		this.client.on("connect", () => {
			Log.info("Connected to MQTT", {
				stateTopic: this.stateTopic,
				setTopic: this.setTopic,
				availabilityTopic: this.availabilityTopic
			});

			this.mqttErrorLogged = false; // Reset error flag on successful connect
			this.mqttCloseLogged = false; // Reset close flag on successful connect

			this.publishConfigs();

			// Publish birth message to availability topic
			this.client.publish(this.availabilityTopic, "online", { retain: true });
			Log.debug("Published availability birth message", {
				topic: this.availabilityTopic,
				payload: "online"
			});

			// Subscribe to /set topics
			this.subscribeToSetTopics();
		});

		this.client.on("error", (err) => {
			if (!this.mqttErrorLogged) {
				Log.error("MQTT connection error", {
					server: `${mqttServer}:${mqttOptions.port}`,
					error: err
				});
				this.mqttErrorLogged = true; // Set error flag to prevent repeated logging
			}
		});

		this.client.on("close", () => {
			if (!this.mqttCloseLogged) {
				Log.debug("MQTT connection closed", {
					availabilityTopic: this.availabilityTopic
				});
				this.mqttCloseLogged = true; // Set close flag to prevent repeated logging
				// Publish last will message to availability topic
				this.client.publish(this.availabilityTopic, "offline", { retain: true });
				Log.debug("Published availability offline message", {
					topic: this.availabilityTopic,
					payload: "offline"
				});
			}
		});
	},

	subscribeToSetTopics () {
		const topics = [this.setTopic];
		if (this.config.pm2ProcessName) {
			topics.push(`${this.setTopic}/restart`);
		}
		if (this.config.refreshBrowser) {
			topics.push(`${this.setTopic}/refresh`);
		}
		if (this.config.customCommands && Array.isArray(this.config.customCommands)) {
			this.config.customCommands.forEach((cmd) => {
				if (cmd.name) {
					const internalName = cmd.name.toLowerCase().replace(/\s+/g, "_");
					topics.push(`${this.setTopic}/${internalName}`);
				}
			});
		}
		Log.debug("Subscribing to MQTT command topics", { topics });
		this.client.subscribe(topics, (err, granted) => {
			if (err) {
				Log.error("Failed to subscribe to set topics", {
					topics,
					error: err
				});
			} else {
				Log.debug("Subscribed to MQTT command topics", { granted });
			}
		});

		this.client.on("message", async (topic, message) => {
			if (topic === this.setTopic) {
				try {
					const rawMessage = message.toString();
					const payload = JSON.parse(rawMessage);
					Log.debug("Received MQTT state command", { topic, payload });

					if ((this.config.brightnessControl || this.config.monitorControl)
					  && payload.state !== undefined && payload.state !== this.monitorValue) {
						await this.handleMonitorSet(payload.state);
					}

					if (this.config.brightnessControl
					  && payload.brightness !== undefined && payload.state !== this.brightnessValue) {
						await this.handleBrightnessSet(payload.brightness);
					}

					if (this.config.moduleControl) {
						if (Array.isArray(this.modules)) {
							this.modules.forEach((element) => {
								if (payload.hasOwnProperty(element.urlPath)) {
									this.handleModuleSet(element.urlPath, payload);
								}
							});
						} else {
							Log.error("this.modules is not an array:", this.modules);
						}
					}
				} catch (err) {
					Log.error("Failed to parse JSON payload", {
						topic,
						rawPayload: message.toString(),
						error: err
					});
				}
			}

			if (topic === `${this.setTopic}/restart`) {
				Log.info("Restart command received", { topic });
				this.handleRestart();
			}

			if (topic === `${this.setTopic}/refresh`) {
				Log.info("Refresh command received", { topic });
				this.handleRefresh();
			}

			// Handle custom commands
			if (this.config.customCommands && Array.isArray(this.config.customCommands)) {
				this.config.customCommands.forEach((cmd) => {
					const internalName = cmd.name.toLowerCase().replace(/\s+/g, "_");
					if (topic === `${this.setTopic}/${internalName}`) {
						Log.info("Custom command received", {
							topic,
							name: cmd.name
						});
						this.handleCustomCommand(cmd);
					}
				});
			}
		});
	},

	handleMonitorSet (payload) {
		Log.debug("Handling monitor set", { payload });

		let command;
		if (payload === "ON") {
			command = this.config.monitorOnCommand;
		} else if (payload === "OFF") {
			command = this.config.monitorOffCommand;
		} else {
			Log.error("Invalid monitor state payload", { payload });
			return;
		}

		if (!command) {
			Log.warn("Monitor command not configured for state", { payload });
			return;
		}

		exec(command, (error, stdout, stderr) => {
			if (error) {
				Log.error("Error executing monitor command", {
					command,
					payload,
					error,
					stderr
				});
				return;
			}
			this.monitorValue = payload;
			Log.debug("Monitor state updated", {
				command,
				state: this.monitorValue,
				stdout: stdout ? stdout.trim() : ""
			});
			this.publishStates();
		});
	},

	handleBrightnessSet (payload) {
		Log.debug("Handling brightness set", { brightness: payload });
		this.sendSocketNotification("BRIGHTNESS_CONTROL", payload);
	},

	handleModuleSet (moduleName, payload) {
		Log.debug("Handling module set", {
			moduleName,
			payload
		});
		const module = this.modules.find((m) => m.urlPath === moduleName);
		if (!module) {
			Log.warn("Module not found for urlPath", { moduleName });
			return;
		}
		const command = payload[moduleName];
		if (!command) {
			Log.debug("No command provided for module", { moduleName, payload });
			return;
		}
		const identifier = module.identifier;
		Log.debug("Forwarding module control command", {
			moduleName,
			identifier,
			command
		});
		this.sendSocketNotification("MODULE_CONTROL", { identifier, command });

	},

	handleRestart () {
		Log.info("Restarting via PM2", {
			processName: this.config.pm2ProcessName
		});
		let pm2;
		try {
			pm2 = require("pm2");
		} catch (err) {
			Log.error("PM2 not installed or unlinked", {
				processName: this.config.pm2ProcessName,
				error: err
			});
			return;
		}
		pm2.connect((err) => {
			if (err) {
				Log.error("PM2 connect error", {
					processName: this.config.pm2ProcessName,
					error: err
				});
				return;
			}
			Log.debug("Restarting PM2 process", {
				processName: this.config.pm2ProcessName
			});
			pm2.restart(this.config.pm2ProcessName, (err) => {
				if (err) {
					Log.error("PM2 restart error", {
						processName: this.config.pm2ProcessName,
						error: err
					});
				} else {
					Log.info("Restarted PM2 process", {
						processName: this.config.pm2ProcessName
					});
				}
				pm2.disconnect();
			});
		});
	},

	async handleRefresh () {
		const url = "http://localhost:8080";
		let browser;
		try {
			Log.debug("Starting browser refresh", { url });
			browser = await puppeteer.launch({
				headless: true,
				executablePath: "/usr/bin/chromium-browser", // or '/usr/bin/chromium' on some systems
				args: ["--no-sandbox", "--disable-setuid-sandbox"]
			});
			const page = await browser.newPage();
			await page.goto(url, { waitUntil: "networkidle0" });
			Log.info("Browser refresh completed", { url });
		} catch (err) {
			Log.error("Error refreshing browser", { url, error: err });
		} finally {
			if (browser) await browser.close();
		}
	},

	handleCustomCommand (commandConfig) {
		if (!commandConfig.command) {
			Log.warn("Custom command missing command property", {
				name: commandConfig.name
			});
			return;
		}

		Log.debug("Executing custom command", {
			name: commandConfig.name,
			command: commandConfig.command
		});
		exec(commandConfig.command, (error, stdout, stderr) => {
			if (error) {
				Log.error("Error executing custom command", {
					name: commandConfig.name,
					command: commandConfig.command,
					error,
					stderr
				});
				return;
			}
			Log.debug("Custom command executed successfully", {
				name: commandConfig.name,
				command: commandConfig.command
			});
			if (stdout) {
				Log.debug("Custom command output", {
					name: commandConfig.name,
					output: stdout.trim()
				});
			}
		});
	},

	async publishConfigs () {
		try {
			const deviceId = this.config.deviceName
				.normalize("NFD") // decompose accented chars
				.replace(/[\u0300-\u036f]/g, "") // remove accents
				.replace(/\W+/g, "_") // replace non-word chars with _
				.replace(/^_+|_+$/g, "") // trim leading/trailing _
				.toLowerCase();
			const sys = await si.system();
			const baseboard = await si.baseboard();

			const uniqueId = (baseboard.serial || `${sys.serial}`)
				.replace(/[^a-zA-Z0-9]/g, "")
				.slice(-8)
				.toLowerCase();

			const deviceJson = {
				device: {
					ids: [uniqueId],
					name: this.config.deviceName,
					mf: sys.manufacturer || baseboard.manufacturer || "unknown",
					mdl: sys.model || baseboard.model || "",
					hw: baseboard.version || "unknown",
					sw: global.version
				}
			};

			Log.debug("Preparing MQTT autodiscovery configs", {
				deviceId,
				uniqueId,
				moduleCount: Array.isArray(this.modules) ? this.modules.length : 0
			});

			const topics = [];
			const payloads = [];

			// Light entity is added if monitorControl or brightnessControl is enabled
			if (this.config.monitorControl || this.config.brightnessControl) {
				const hasBrightness = !!this.config.brightnessControl;
				const lightJson = {
					availability_topic: this.availabilityTopic,
					state_topic: this.stateTopic,
					command_topic: this.setTopic,
					brightness: this.config.brightnessControl,
					brightness_scale: 100,
					schema: "json",
					value_template: "{{ value_json.state }}",
					supported_color_modes: [hasBrightness ? "brightness" : "onoff"],
					name: null,
					default_entity_id: `light.${deviceId}_light`,
					unique_id: `${deviceId}_light`
				};

				// Publish light configuration to MQTT autodiscovery topic
				const lightConfigTopic = `${this.config.autodiscoveryTopic}/light/${deviceId}/config`;
				const combinedJson = { ...deviceJson, ...lightJson };

				topics.push(lightConfigTopic);
				payloads.push(JSON.stringify(combinedJson));
			}

			if (this.config.moduleControl) {
				this.modules.forEach((element) => {
					const switchJson = {
						availability_topic: this.availabilityTopic,
						state_topic: this.stateTopic,
						command_topic: this.setTopic,
						entity_category: "config",
						schema: "json",
						value_template: `{{ value_json.${element.urlPath} }}`,
						command_template: `{"${element.urlPath}": "{{ value }}" }`,
						name: element.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
						default_entity_id: `switch.${deviceId}_${element.urlPath}_switch`,
						unique_id: `${deviceId}_${element.urlPath}_switch`
					};
					topics.push(`${this.config.autodiscoveryTopic}/switch/${deviceId}/${element.urlPath}/config`);
					payloads.push(JSON.stringify({ ...deviceJson, ...switchJson }));
				});
			}

			if (this.config.pm2ProcessName) {
				const restartButtonJson = {
					availability_topic: this.availabilityTopic,
					command_topic: `${this.setTopic}/restart`,
					device_class: "restart",
					payload_press: "identify",
					entity_category: "diagnostic",
					name: "Restart",
					default_entity_id: `button.${deviceId}_restart`,
					unique_id: `${deviceId}_restart`
				};

				// Publish light configuration to MQTT autodiscovery topic
				const restartConfigTopic = `${this.config.autodiscoveryTopic}/button/${deviceId}/restart/config`;
				const combinedJson = { ...deviceJson, ...restartButtonJson };

				topics.push(restartConfigTopic);
				payloads.push(JSON.stringify(combinedJson));
			}

			if (this.config.refreshBrowser) {
				const refreshButtonJson = {
					availability_topic: this.availabilityTopic,
					command_topic: `${this.setTopic}/refresh`,
					device_class: "restart",
					payload_press: "identify",
					entity_category: "diagnostic",
					name: "Refresh Browser",
					default_entity_id: `button.${deviceId}_refresh_browser`,
					unique_id: `${deviceId}_refresh_browser`
				};

				// Publish light configuration to MQTT autodiscovery topic
				const refreshConfigTopic = `${this.config.autodiscoveryTopic}/button/${deviceId}/refresh/config`;
				const combinedJson = { ...deviceJson, ...refreshButtonJson };

				topics.push(refreshConfigTopic);
				payloads.push(JSON.stringify(combinedJson));
			}

			if (this.config.customCommands && Array.isArray(this.config.customCommands)) {
				this.config.customCommands.forEach((cmd) => {
					if (cmd.name && cmd.command) {
						const internalName = cmd.name.toLowerCase().replace(/\s+/g, "_");
						const customButtonJson = {
							availability_topic: this.availabilityTopic,
							command_topic: `${this.setTopic}/${internalName}`,
							payload_press: "execute",
							entity_category: "diagnostic",
							name: cmd.name,
							default_entity_id: `button.${deviceId}_${internalName}`,
							unique_id: `${deviceId}_${internalName}`
						};

						const customConfigTopic = `${this.config.autodiscoveryTopic}/button/${deviceId}/${internalName}/config`;
						const combinedJson = { ...deviceJson, ...customButtonJson };

						topics.push(customConfigTopic);
						payloads.push(JSON.stringify(combinedJson));
					}
				});
			}

			topics.forEach((topic, index) => {
				const payload = payloads[index];
				this.client.publish(topic, payload, { retain: true });
				Log.debug("Published MQTT autodiscovery config", {
					topic,
					payload
				});
			});

		} catch (err) {
			Log.error("Failed to publish configs", { error: err });
		}
	},

	publishStates () {
		// Publish initial values to the device topic as JSON
		const payload = {};
		if (this.config.brightnessControl || this.config.monitorControl) {
			payload.state = this.monitorValue;
		}
		if (this.config.brightnessControl) {
			payload.brightness = this.brightnessValue;
		}
		if (this.config.moduleControl) {
			this.modules.forEach((element) => {
				payload[element.urlPath] = element.hidden ? "OFF" : "ON";
			});
		}

		if (Object.keys(payload).length > 0) {
			Log.debug("Publishing MQTT state update", {
				topic: this.stateTopic,
				payload
			});
			this.client.publish(this.stateTopic, JSON.stringify(payload), { retain: true });
		}
	},

	watchEndpoints () {
		if (this.config.monitorStatusCommand) {

			const pollMonitorStatus = () => {
				exec(this.config.monitorStatusCommand, (error, stdout, stderr) => {
					if (error) {
						Log.error("Error executing monitorStatusCommand", {
							command: this.config.monitorStatusCommand,
							error,
							stderr
						});
						return;
					}
					const trimmed = stdout.trim().toLowerCase();
					// Interpret "true" as ON, "false" as OFF
					const newValue = (trimmed === "true" || trimmed === "1") ? "ON" : "OFF";
					if (newValue !== this.monitorValue) {
						this.monitorValue = newValue;
						Log.debug("Monitor status polled", {
							command: this.config.monitorStatusCommand,
							state: this.monitorValue,
							rawOutput: stdout.trim()
						});
						this.publishStates();
					}
				});
			};

			Log.debug("Starting monitor status polling", {
				command: this.config.monitorStatusCommand
			});
			pollMonitorStatus();
			setInterval(pollMonitorStatus, 5000);
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "MQTT_INIT") {
			this.config = payload;
			this.stateTopic = this.config.deviceName;
			this.setTopic = `${this.config.deviceName}/set`;
			this.availabilityTopic = `${this.config.deviceName}/availability`;
			Log.debug("Received MQTT_INIT payload", {
				deviceName: this.config.deviceName,
				topicDeviceName: this.config.deviceName,
				stateTopic: this.stateTopic,
				setTopic: this.setTopic,
				availabilityTopic: this.availabilityTopic,
				controls: {
					monitor: !!this.config.monitorControl,
					brightness: !!this.config.brightnessControl,
					modules: !!this.config.moduleControl,
					refreshBrowser: !!this.config.refreshBrowser,
					customCommands: Array.isArray(this.config.customCommands) ? this.config.customCommands.length : 0
				}
			});
			this.watchEndpoints();
			this.connectMQTT();

			if (this.config.device && this.config.device.some((device) => device.gpio)) {
				// this.initGPIO();
			}
		}

		if (notification === "MODULES_UPDATE") {
			const wasEmpty = !Array.isArray(this.modules) || this.modules.length === 0;
			this.modules = payload;
			if (wasEmpty) {
				Log.debug("Received initial module list from frontend", {
					moduleCount: Array.isArray(this.modules) ? this.modules.length : 0
				});
			}
			else {
				Log.debug("Received module state update from frontend", {
					moduleCount: Array.isArray(this.modules) ? this.modules.length : 0
				});
				this.publishStates();
			}
		}

		if (notification === "BRIGHTNESS_UPDATE") {
			const newBrightness = Math.max(0, Math.min(100, payload));
			if (newBrightness !== this.brightnessValue) {
				this.brightnessValue = newBrightness;
				Log.debug("Received brightness update from frontend", {
					brightness: this.brightnessValue
				});
				this.publishStates();
			}
		}
	}
});

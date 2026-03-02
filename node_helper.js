'use strict';
const NodeHelper = require('node_helper');
const Log = require('logger');
const mqtt = require('mqtt');
const puppeteer = require('puppeteer');
const si = require('systeminformation');
const { exec } = require('child_process');
// const Gpio = require('onoff').Gpio;

module.exports = NodeHelper.create({
  start: function () {
    Log.info('[MMM-HomeAssistant] Module started');
    this.clients = {};

    this.config = null;
    this.modules = null;

    this.stateTopic = null;
    this.setTopic = null;
    this.availabilityTopic = null;

    this.monitorValue = 'unknown';
    this.brightnessValue = 0;

    const nsp = this.io.of('/MMM-HomeAssistant');
    nsp.on('connection', (socket) => {
      Log.debug('[MMM-HomeAssistant] Socket connected:', socket.id);
      this.clients[socket.id] = true;

      socket.on('disconnect', () => {
        Log.debug('[MMM-HomeAssistant] Socket disconnected:', socket.id);
        delete this.clients[socket.id];
        if (Object.keys(this.clients).length === 0) {
          // No clients connected, disconnect from MQTT
          if (this.client) {
            Log.debug('[MMM-HomeAssistant] No clients connected, disconnecting from MQTT');
            this.client.end();
            this.client = null;
          }
        }
      });
    });
  },

  normalizeMqttServer: function (serverUrl) {
    if (!serverUrl) return serverUrl;
    if (!/^mqtt(s)?:\/\//.test(serverUrl)) {
      return `mqtt://${serverUrl}`;
    }
    return serverUrl;
  },

  connectMQTT: function () {
    if (this.client) return;

    if (!this.config || !this.config.mqttServer) {
      throw new Error('[MMM-HomeAssistant] MQTT server URL is missing in the configuration.');
    }

    const mqttServer = this.normalizeMqttServer(this.config.mqttServer);

    const mqttOptions = {
      clientId: this.config.deviceName || `MagicMirror_${Math.random().toString(16).substr(2, 8)}`,
      username: this.config.username || undefined,
      password: this.config.password || undefined,
      port: this.config.mqttPort || 1883, // Default MQTT port
      will: {
        topic: this.availabilityTopic,
        payload: 'offline',
        retain: true,
        qos: 1,
      },
    };

    // Remove undefined properties for anonymous authentication
    if (!mqttOptions.username) delete mqttOptions.username;
    if (!mqttOptions.password) delete mqttOptions.password;

    Log.debug('[MMM-HomeAssistant] Connecting to MQTT server:', `${mqttServer}:${mqttOptions.port}`);
    this.client = mqtt.connect(mqttServer, mqttOptions);

    this.client.on('connect', () => {
      Log.info('[MMM-HomeAssistant] Connected to MQTT');

      this.mqttErrorLogged = false; // Reset error flag on successful connect
      this.mqttCloseLogged = false; // Reset close flag on successful connect

      this.publishConfigs();

      // Publish birth message to availability topic
      this.client.publish(this.availabilityTopic, 'online', { retain: true });

      // Subscribe to /set topics
      this.subscribeToSetTopics();
    });

    this.client.on('error', (err) => {
      if (!this.mqttErrorLogged) {
        Log.error('[MMM-HomeAssistant] MQTT connection error:', err);
        this.mqttErrorLogged = true; // Set error flag to prevent repeated logging
      }
    });

    this.client.on('close', () => {
      if (!this.mqttCloseLogged) {
        Log.debug('[MMM-HomeAssistant] MQTT connection closed');
        this.mqttCloseLogged = true; // Set close flag to prevent repeated logging
        // Publish last will message to availability topic
        this.client.publish(this.availabilityTopic, 'offline', { retain: true });
      }
    });
  },

  subscribeToSetTopics: function () {
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
          const internalName = cmd.name.toLowerCase().replace(/\s+/g, '_');
          topics.push(`${this.setTopic}/${internalName}`);
        }
      });
    }
    this.client.subscribe(topics, (err, granted) => {
      if (err) {
        Log.error('[MMM-HomeAssistant] Failed to subscribe to set topics:', err);
      } else {
        Log.debug('[MMM-HomeAssistant] Subscribed to topics:', granted.map(g => g.topic).join(', '));
      }
    });

    this.client.on('message', async (topic, message) => {
      if (topic === this.setTopic) {
        try {
          const payload = JSON.parse(message.toString());
          Log.debug(`[MMM-HomeAssistant] Received message on topic ${topic}:`, payload);

          if ((this.config.brightnessControl || this.config.monitorControl) &&
            payload.state !== undefined && payload.state !== this.monitorValue) {
            await this.handleMonitorSet(payload.state);
          }

          if (this.config.brightnessControl &&
            payload.brightness !== undefined && payload.state !== this.brightnessValue) {
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
              Log.error('[MMM-HomeAssistant] this.modules is not an array:', this.modules);
            }
          }
        } catch (err) {
          Log.error('[MMM-HomeAssistant] Failed to parse JSON payload:', err);
        }
      }

      if (topic === `${this.setTopic}/restart`) {
        Log.info('[MMM-HomeAssistant] Restart command received');
        this.handleRestart();
      }

      if (topic === `${this.setTopic}/refresh`) {
        Log.info('[MMM-HomeAssistant] Refresh command received');
        this.handleRefresh();
      }

      // Handle custom commands
      if (this.config.customCommands && Array.isArray(this.config.customCommands)) {
        this.config.customCommands.forEach((cmd) => {
          const internalName = cmd.name.toLowerCase().replace(/\s+/g, '_');
          if (topic === `${this.setTopic}/${internalName}`) {
            Log.info(`[MMM-HomeAssistant] Custom command received: ${cmd.name}`);
            this.handleCustomCommand(cmd);
          }
        });
      }
    });
  },

  handleMonitorSet: async function (payload) {
    Log.debug('[MMM-HomeAssistant] Handling monitor set:', payload);

    let command;
    if (payload === 'ON') {
      command = this.config.monitorOnCommand;
    } else if (payload === 'OFF') {
      command = this.config.monitorOffCommand;
    } else {
      Log.error('[MMM-HomeAssistant] Invalid monitor state payload:', payload);
      return;
    }

    if (!command) {
      Log.warn('[MMM-HomeAssistant] Monitor command not configured for state:', payload);
      return;
    }

    exec(command, (error, stdout, stderr) => {
      if (error) {
        Log.error('[MMM-HomeAssistant] Error executing monitor command:', error);
        return;
      }
      this.monitorValue = payload;
      this.publishStates();
    });
  },

  handleBrightnessSet: async function (payload) {
    Log.debug('[MMM-HomeAssistant] Handling brightness set:', payload);
    this.sendSocketNotification("BRIGHTNESS_CONTROL", payload);
  },

  handleModuleSet: async function (moduleName, payload) {
    Log.debug(`[MMM-HomeAssistant] Handling module set for ${moduleName}`);
    const module = this.modules.find(m => m.urlPath === moduleName);
    if (!module) {
      Log.warn('[MMM-HomeAssistant] Module not found for urlPath:', moduleName);
      return;
    }
    const command = payload[moduleName];
    if (!command) {
      Log.debug('[MMM-HomeAssistant] No command provided for module:', moduleName);
      return;
    }
    const identifier = module.identifier;
    this.sendSocketNotification("MODULE_CONTROL", { identifier, command });

  },

  handleRestart: function () {
    Log.info('[MMM-HomeAssistant] Restarting via PM2');
    let pm2;
    try {
      pm2 = require('pm2');
    } catch (err) {
      Log.debug('[MMM-HomeAssistant] PM2 not installed or unlinked');
      return;
    }
    pm2.connect((err) => {
      if (err) {
        Log.error('[MMM-HomeAssistant] PM2 connect error:', err);
        return;
      }
      Log.debug(`[MMM-HomeAssistant] Restarting PM2 process: ${this.config.pm2ProcessName}`);
      pm2.restart(this.config.pm2ProcessName, (err) => {
        if (err) {
          Log.error('[MMM-HomeAssistant] PM2 restart error:', err);
        } else {
          Log.info(`[MMM-HomeAssistant] Restarted PM2 process: ${this.config.pm2ProcessName}`);
        }
        pm2.disconnect();
      });
    });
  },

  handleRefresh: async function () {
    const url = 'http://localhost:8080';
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: '/usr/bin/chromium-browser', // or '/usr/bin/chromium' on some systems
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      Log.info(`[MMM-HomeAssistant] Browser refresh completed`);
    } catch (err) {
      Log.error('[MMM-HomeAssistant] Error refreshing browser:', err);
    } finally {
      if (browser) await browser.close();
    }
  },

  handleCustomCommand: function (commandConfig) {
    if (!commandConfig.command) {
      Log.warn('[MMM-HomeAssistant] Custom command missing command property:', commandConfig.name);
      return;
    }

    Log.debug(`[MMM-HomeAssistant] Executing custom command: ${commandConfig.name}`);
    exec(commandConfig.command, (error, stdout, stderr) => {
      if (error) {
        Log.error(`[MMM-HomeAssistant] Error executing custom command '${commandConfig.name}':`, error);
        return;
      }
      Log.debug(`[MMM-HomeAssistant] Custom command '${commandConfig.name}' executed successfully`);
      if (stdout) {
        Log.debug(`[MMM-HomeAssistant] Command output: ${stdout}`);
      }
    });
  },

  publishConfigs: async function () {
    try {
      const deviceId = this.config.deviceName
        .normalize('NFD') // decompose accented chars
        .replace(/[\u0300-\u036f]/g, '') // remove accents
        .replace(/\W+/g, '_') // replace non-word chars with _
        .replace(/^_+|_+$/g, '') // trim leading/trailing _
        .toLowerCase();
      const sys = await si.system();
      const baseboard = await si.baseboard();

      const uniqueId = (baseboard.serial || sys.serial + '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(-8)
        .toLowerCase();

      const deviceJson = {
        device: {
          ids: [uniqueId],
          name: this.config.deviceName,
          mf: sys.manufacturer || baseboard.manufacturer || 'unknown',
          mdl: sys.model || baseboard.model || '',
          hw: baseboard.version || 'unknown',
          sw: global.version,
        },
      };

      const topics = [];
      const payloads = [];

      // Light entity is added if monitorControl or brightnessControl is enabled
      if (this.config.monitorControl || this.config.brightnessControl) {
        const lightJson = {
          availability_topic: this.availabilityTopic,
          state_topic: this.stateTopic,
          command_topic: this.setTopic,
          brightness: this.config.brightnessControl,
          brightness_scale: 100,
          schema: "json",
          value_template: "{{ value_json.state }}",
          name: null,
          default_entity_id: `light.${deviceId}_light`,
          unique_id: `${deviceId}_light`,
        };

        // Publish light configuration to MQTT autodiscovery topic
        const lightConfigTopic = `${this.config.autodiscoveryTopic}/light/${deviceId}/config`;
        const combinedJson = { ...deviceJson, ...lightJson };

        topics.push(lightConfigTopic);
        payloads.push(JSON.stringify(combinedJson));
      }

      if (this.config.moduleControl) {
        this.modules.forEach(element => {
          const switchJson = {
            availability_topic: this.availabilityTopic,
            state_topic: this.stateTopic,
            command_topic: this.setTopic,
            entity_category: "config",
            schema: "json",
            value_template: `{{ value_json.${element.urlPath} }}`,
            command_template: `{"${element.urlPath}": "{{ value }}" }`,
            name: element.name.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()),
            default_entity_id: `switch.${deviceId}_${element.urlPath}_switch`,
            unique_id: `${deviceId}_${element.urlPath}_switch`,
          }
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
          name: 'Restart',
          default_entity_id: `button.${deviceId}_restart`,
          unique_id: `${deviceId}_restart`,
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
          name: 'Refresh Browser',
          default_entity_id: `button.${deviceId}_refresh_browser`,
          unique_id: `${deviceId}_refresh_browser`,
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
            const internalName = cmd.name.toLowerCase().replace(/\s+/g, '_');
            const customButtonJson = {
              availability_topic: this.availabilityTopic,
              command_topic: `${this.setTopic}/${internalName}`,
              payload_press: "execute",
              entity_category: "diagnostic",
              name: cmd.name,
              default_entity_id: `button.${deviceId}_${internalName}`,
              unique_id: `${deviceId}_${internalName}`,
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
        Log.debug('[MMM-HomeAssistant] Published config to:', topic);
      });

    } catch (err) {
      Log.error('[MMM-HomeAssistant] Failed to publish configs:', err);
    }
  },

  publishStates: function () {
    // Publish initial values to the device topic as JSON
    const payload = {};
    if (this.config.brightnessControl || this.config.monitorControl) {
      payload.state = this.monitorValue;
    }
    if (this.config.brightnessControl) {
      payload.brightness = this.brightnessValue;
    }
    if (this.config.moduleControl) {
      this.modules.forEach(element => {
        payload[element.urlPath] = element.hidden ? 'OFF' : 'ON';
      });
    }

    if (Object.keys(payload).length > 0) {
      Log.debug('[MMM-HomeAssistant] Updated state:', payload);
      this.client.publish(this.stateTopic, JSON.stringify(payload), { retain: true });
    }
  },

  watchEndpoints: function () {
    if (this.config.monitorStatusCommand) {

      const pollMonitorStatus = () => {
        exec(this.config.monitorStatusCommand, (error, stdout, stderr) => {
          if (error) {
            Log.error('[MMM-HomeAssistant] Error executing monitorStatusCommand:', error);
            return;
          }
          const trimmed = stdout.trim().toLowerCase();
          // Interpret "true" as ON, "false" as OFF
          const newValue = (trimmed === 'true' || trimmed === '1') ? 'ON' : 'OFF';
          if (newValue !== this.monitorValue) {
            this.monitorValue = newValue;
            this.publishStates();
          }
        });
      };

      pollMonitorStatus();
      setInterval(pollMonitorStatus, 5000);
    }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === 'MQTT_INIT') {
      this.config = payload;
      this.stateTopic = this.config.deviceName;
      this.setTopic = `${this.config.deviceName}/set`;
      this.availabilityTopic = `${this.config.deviceName}/availability`;
      this.watchEndpoints();
      this.connectMQTT();

      if (this.config.device && this.config.device.some(device => device.gpio)) {
        // this.initGPIO();
      }
    }

    if (notification === 'MODULES_UPDATE') {
      const wasEmpty = !Array.isArray(this.modules) || this.modules.length === 0;
      this.modules = payload;
      if (wasEmpty) {
        Log.debug('[MMM-HomeAssistant] Received module list from frontend');
      }
      else {
        this.publishStates();
      }
    }

    if (notification === 'BRIGHTNESS_UPDATE') {
      const newBrightness = Math.max(0, Math.min(100, payload));
      if (newBrightness !== this.brightnessValue) {
        this.brightnessValue = newBrightness;
        this.publishStates();
      }
    }
  },
});

Module.register("MMM-HomeAssistant", {

  defaults: {
    deviceName: "My MagicMirror",
    autodiscoveryTopic: "homeassistant",
    mqttServer: "mqtt://localhost",
    mqttPort: 1883,
    monitorStatusCommand: "echo true",
    monitorOnCommand: "",
    monitorOffCommand: "",
    refreshBrowser: true,
  },

  start: function () {
    Log.info('Starting module: ' + this.name);
    this.modules = [];
  },

  getStyles: function () {
    return ["MMM-HomeAssistant.css"];
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = "MMM-HomeAssistant Module Active";
    return wrapper;
  },

  sendModules() {
    const getBaseName = (module) => module.name.replace(/MMM-/g, "").replace(/-/g, "");
    const getUrlPath = (name) => name.toLowerCase().replace(/\s+/g, "_");

    // Handling multiple instances of the same module
    const baseNameCounts = {};
    this.modules.enumerate((module) => {
      const baseName = getBaseName(module);
      baseNameCounts[baseName] = (baseNameCounts[baseName] || 0) + 1;
    });
    const nameInstance = {};
    const currentModuleData = [];
    this.modules.enumerate((module) => {
      const baseName = getBaseName(module);
      nameInstance[baseName] = (nameInstance[baseName] || 0) + 1;
      let name = baseName;
      if (baseNameCounts[baseName] > 1) {
        name = `${baseName}_${nameInstance[baseName]}`;
      }
      const entry = {};
      entry.identifier = module.identifier;
      entry.hidden = module.hidden;
      entry.name = name;
      entry.urlPath = getUrlPath(name);
      currentModuleData.push(entry);
    });
    this.sendSocketNotification("MODULES_UPDATE", currentModuleData);
  },

  monitorOverlayBrightness: function () {
    // Find divs with region="tabs"
    const getDivs = () => {
      return Array.from(document.body.children)
        .filter(child => child.tagName === 'DIV' && child.classList.contains('region'));
    };
    const getBrightness = (overlays) => {
      if (!overlays || overlays.length === 0) return 100;
      let maxBrightness = 0;
      overlays.forEach((overlay) => {
        let brightness = 100;
        const filter = overlay.style.filter;
        if (filter) {
          const match = filter.match(/brightness\((\d+)%?\)/i);
          if (match && match[1]) {
            brightness = parseInt(match[1], 10);
          } else {
            const floatMatch = filter.match(/brightness\((0?\.\d+)\)/i);
            if (floatMatch && floatMatch[1]) {
              brightness = Math.round(parseFloat(floatMatch[1]) * 100);
            }
          }
        }
        if (brightness > maxBrightness) maxBrightness = brightness;
      });
      return maxBrightness;
    };

    let divs = getDivs();
    let lastBrightness = getBrightness(divs);

    // Send initial brightness value
    this.sendSocketNotification("BRIGHTNESS_UPDATE", lastBrightness);

    divs.forEach((overlay) => {
      const observer = new MutationObserver(() => {
        const newBrightness = getBrightness(getDivs());
        if (newBrightness !== lastBrightness) {
          this.sendSocketNotification("BRIGHTNESS_UPDATE", newBrightness);
          lastBrightness = newBrightness;
        }
      });
      observer.observe(overlay, { attributes: true, attributeFilter: ['style'] });
    });
  },

  monitorModulesHiddenState() {
    this.modules.enumerate((module) => {
      const div = document.getElementById(module.identifier);
      if (!div) return;
      let lastHidden = module.hidden;
      const observer = new MutationObserver(() => {
        if (module.hidden !== lastHidden) {
          lastHidden = module.hidden;
          this.sendModules();
        }
      });
      observer.observe(div, { attributes: true, attributeFilter: ['class'] });
    });
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MODULE_CONTROL") {
      Log.info(`[MMM-HomeAssistant] Module control received: ${payload.identifier} ${payload.command}`);
      const module = this.modules.find(m => m.identifier === payload.identifier);
      if (!module) {
        Log.warn(`[MMM-HomeAssistant] Module not found: ${payload.identifier}`);
        return;
      }
      if (payload.command === 'ON') {
        module.show(1000, function () { }, { lockString: payload.moduleName });
      } else if (payload.command === 'OFF') {
        module.hide(1000, function () { }, { lockString: payload.moduleName });
      }
    }

    if (notification === "BRIGHTNESS_CONTROL") {
      const childNodesList = document.body.childNodes;
      for (let i = 0; i < childNodesList.length; i++) {
        if (childNodesList[i].nodeName !== "SCRIPT" && childNodesList[i].nodeName !== "#text") {
            childNodesList[i].style.filter = `brightness(${payload}%)`;
        }
      }
    }
  },

  notificationReceived: function (notification, payload, sender) {
    if (notification === "DOM_OBJECTS_CREATED") {
      if (this.config.moduleControl === true) {
        this.modules = MM.getModules()
          .exceptModule(this)
          .exceptWithClass("MMM-Remote-Control")
          .exceptWithClass("alert");
        this.sendModules();
      }
      this.sendSocketNotification("MQTT_INIT", this.config);
      this.monitorOverlayBrightness();
      if (this.config.moduleControl === true) {
        this.monitorModulesHiddenState();
      }
    }
  },
})

"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");

class FakeMqttClient extends EventEmitter {
	constructor () {
		super();
		this.connected = false;
		this.disconnecting = false;
		this.published = [];
		this.subscriptions = [];
	}

	publish (...args) {
		this.published.push(args);
	}

	subscribe (topics, callback) {
		this.subscriptions.push(topics);
		callback(null, []);
	}
}

function loadHelper () {
	const client = new FakeMqttClient();
	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === "node_helper") return { create: (definition) => definition };
		if (request === "logger") {
			return { debug () {}, error () {}, info () {}, warn () {} };
		}
		if (request === "mqtt") return { connect: () => client };
		if (request === "puppeteer") return {};
		if (request === "systeminformation") return {};
		return originalLoad(request, parent, isMain);
	};

	const helperPath = require.resolve("../node_helper");
	delete require.cache[helperPath];
	let helper;
	try {
		helper = require(helperPath);
	} finally {
		Module._load = originalLoad;
	}

	helper.config = {
		deviceName: "Test Mirror",
		mqttServer: "mqtt://localhost",
		moduleControl: true
	};
	helper.modules = [{ urlPath: "clock", hidden: false }];
	helper.stateTopic = "Test Mirror";
	helper.setTopic = "Test Mirror/set";
	helper.availabilityTopic = "Test Mirror/availability";
	helper.publishConfigCalls = 0;
	helper.publishConfigs = async () => {
		helper.publishConfigCalls += 1;
	};
	helper.connectMQTT();
	return { client, helper };
}

test("close is safe when the current client is already null", () => {
	const { client, helper } = loadHelper();
	helper.client = null;
	assert.doesNotThrow(() => client.emit("close"));
});

test("close does not publish when the client is disconnected", () => {
	const { client } = loadHelper();
	client.connected = false;
	client.emit("close");
	assert.equal(client.published.length, 0);
});

test("publishStates is safe without a client", () => {
	const { helper } = loadHelper();
	helper.client = null;
	assert.doesNotThrow(() => helper.publishStates());
});

test("publishStates skips a disconnected client", () => {
	const { client, helper } = loadHelper();
	client.connected = false;
	helper.publishStates();
	assert.equal(client.published.length, 0);
});

test("publishStates publishes normally while connected", () => {
	const { client, helper } = loadHelper();
	client.connected = true;
	helper.publishStates();
	assert.deepEqual(client.published, [[
		"Test Mirror",
		JSON.stringify({ clock: "ON" }),
		{ retain: true }
	]]);
});

test("publishing resumes after reconnect", () => {
	const { client, helper } = loadHelper();
	client.connected = true;
	client.emit("connect");
	client.connected = false;
	client.emit("close");
	client.connected = true;
	client.emit("connect");
	assert.equal(client.published.filter(([topic]) => topic === "Test Mirror/availability").length, 2);
	client.published = [];
	helper.publishStates();
	assert.equal(client.published.length, 1);
	assert.equal(helper.publishConfigCalls, 2);
});

test("publishing is skipped while the client is shutting down", () => {
	const { client, helper } = loadHelper();
	client.connected = true;
	client.disconnecting = true;
	helper.publishStates();
	assert.equal(client.published.length, 0);
});

test("reconnect does not duplicate message handling", () => {
	const { client, helper } = loadHelper();
	helper.config.pm2ProcessName = "test-process";
	let restartCalls = 0;
	helper.handleRestart = () => {
		restartCalls += 1;
	};
	client.connected = true;
	client.emit("connect");
	client.emit("close");
	client.connected = true;
	client.emit("connect");
	assert.equal(client.listenerCount("message"), 1);
	client.emit("message", "Test Mirror/set/restart", Buffer.from("restart"));
	assert.equal(restartCalls, 1);
});

test("close handler leaves offline availability to the Last Will", () => {
	const { client } = loadHelper();
	client.connected = true;
	client.emit("connect");
	client.published = [];
	client.connected = false;
	client.emit("close");
	assert.equal(client.published.length, 0);
});

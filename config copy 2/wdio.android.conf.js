const path = require("path");
const { config } = require("./wdio.shared.conf");
//
//==============
//Capabilities
//==============
(config.port = 4723),
  //
  //==============
  //Specs folder
  //==============
  (config.specs = ["../test/specs/android/**/*.spec.js"]);

//
//==============
//Capabilities
//==============
config.capabilities = [
  {
    "appium:platformName": "Android",
    "appium:deviceName": "Pixel 8 Pro api 35",
    "appium:automationName": "UiAutomator2",
    // "appium:udid": "emulator-5556",
    "appium:app": path.join(process.cwd(), "app/android/moneyup.apk"),
    "appium:disableWindowAnimation": true,
    "appium:autoGrantPermissions": true,
    "appium:noReset": false,
  },
];

//
//==============
//Services
//==============
(config.services = ["appium"]), (exports.config = config);

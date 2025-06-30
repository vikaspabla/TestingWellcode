async function reopenApp() {
  await driver.execute("mobile: terminateApp", { appId: "ca.moneyup.app" });
  await driver.pause(1000);
  await driver.startActivity("ca.moneyup.app", "ca.moneyup.app.MainActivity");
}

module.exports = reopenApp;

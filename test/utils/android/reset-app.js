async function resetApp() {

    await driver.QuitApplication
    await driver.execute('mobile: clearApp', { appId: 'comm.mybeaconapp' });
    await driver.pause(1000)
    await driver.startActivity('comm.mybeaconapp', 'comm.mybeaconapp.MainActivity');

}

module.exports = resetApp;
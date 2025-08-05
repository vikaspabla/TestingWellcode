const reopenApp = require("../../utils/android/reopen-app");

const splashScreen = require("../../screen/android/splash-screen");

describe("Splash Screen Test Suite", () => {
  afterEach(async () => {
    await reopenApp();
  });


  it("Users should be able to see Welcome carousel and swipe the slides to see a different one", async () => {
    await expect(await splashScreen.splashScreen).toBeDisplayed();

    await expect(splashScreen.createAccountBtn.toBeDisplayed());

    // Swipe left
    await $(
      "android=new UiScrollable(new UiSelector().scrollable(true)).setAsHorizontalList().scrollForward()"
    );

    await expect(await splashScreen.splashScreenText2).toBeDisplayed();

    // Swipe left
    await $(
      "android=new UiScrollable(new UiSelector().scrollable(true)).setAsHorizontalList().scrollForward()"
    );

    await expect(await splashScreen.splashScreenText3).toBeDisplayed();
  });


  it("Users should be able to see and click the 'Create Account' button", async () => {
    await expect(await splashScreen.splashScreen).toBeDisplayed();

    await expect(splashScreen.createAccountBtn.toBeDisplayed());

    await splashScreen.createAccountBtn.click();

    await expect(splashScreen.signUpPage.toBeDisplayed());
  });
  

  it("Users should be able to see and click the 'Sign in' button", async () => {
    await expect(await splashScreen.splashScreen).toBeDisplayed();

    await expect(splashScreen.signInBtn.toBeDisplayed());

    await splashScreen.signInBtn.click();

    await expect(splashScreen.signInPage.toBeDisplayed());
  });
});

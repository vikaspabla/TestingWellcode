class SplashScreen {
  get splashScreen() {
    return $(
      "~Welcome to MoneyUp!\nThe credit app that makes managing money stress-free with tools to help you borrow, save, and plan better."
    );
  }

  get createAccountBtn() {
    return $("~Create Account");
  }

  get signUpPage() {
    return $("~Sign up with email");
  }

  get signInBtn() {
    return $("~Sign in");
  }

  get signInPage() {
    return $("~Sign in to your account");
  }

  get splashScreenText1() {
    return $(
      "~Welcome to MoneyUp!\nThe credit app that makes managing money stress-free with tools to help you borrow, save, and plan better."
    );
  }

  get splashScreenText2() {
    return $(
      "~Borrow. Repay. Repeat.\nAccess your FastForward line of credit every month without re-approval and borrow what you need, when you need it. Want to let it grow instead? Do it. There's no fees if you don't borrow."
    );
  }

  get splashScreenText3() {
    return $(
      "~Build your credit\nWe report your FastForward repayments to your credit profile. That means you can boost your credit score by making on-time payments."
    );
  }
}
module.exports = new SplashScreen();

async function waitForElement(selector, timeout = 10000, interval = 1000) {
    const endTime = Date.now() + timeout;

    while (Date.now() < endTime) {
        const element = await selector 
        const exists = await element.isExisting();
        if (exists) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }

    return false;
}

async function waitForElementEnabled(selector, timeout = 30000, checkInterval = 1000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        const element = await selector; 
        const isEnabled = await element.getAttribute('enabled') === 'true'; 

        if (isEnabled) {
            await element.click(); 
            console.log('Element is enabled and clicked.');
            return; 
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error('Element did not become enabled within the timeout period.');
}

async function waitForLabelValue(element, timeout = 10000, checkInterval = 1000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        const labelValue = await element.getAttribute('label');

        if (labelValue && labelValue.trim() !== '') {
            console.log(`Label found: ${labelValue}`);
            return labelValue; // Exit once a non-empty label is found
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error('Label did not have a value within the timeout period.');
}

async function waitForTextValue(element, timeout = 10000, checkInterval = 1000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        const labelValue = await element.getAttribute('text');

        if (labelValue && labelValue.trim() !== '') {
            console.log(`Label found: ${labelValue}`);
            return labelValue; // Exit once a non-empty label is found
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error('Label did not have a value within the timeout period.');
}

module.exports = {
    waitForElement,
    waitForElementEnabled,
    waitForLabelValue,
    waitForTextValue
};
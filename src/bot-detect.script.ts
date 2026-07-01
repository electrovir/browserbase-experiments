import {check} from '@augment-vir/assert';
import {
    combineErrors,
    ensureErrorAndPrependMessage,
    filterMap,
    log,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {runBotDetector} from './bot-detect.js';
import {type PageTask} from './browser-runner.js';
import {withBrowserbasePage} from './browserbase.js';
import {deleteScreenshots, screenshotPngPath} from './file-paths.js';
import {navigateAndScreenshot} from './navigate-and-screenshot.js';
import {withPlaywrightPage} from './playwright.js';
import {createSecretsClient} from './secrets.js';

// cspell:ignore deviceandbrowserinfo
const areYouABotUrl = 'https://deviceandbrowserinfo.com/are_you_a_bot';

async function runBotDetection() {
    await deleteScreenshots();

    const secretsClient = await createSecretsClient();

    const pageTask: PageTask<void> = async ({page, label}) => {
        await runBotDetector({
            page,
            screenshotPngPath: screenshotPngPath(`rebrowser-${label}`),
        });
        await navigateAndScreenshot({
            page,
            url: areYouABotUrl,
            screenshotPngPath: screenshotPngPath(`are-you-a-bot-${label}`),
        });
    };

    try {
        const results = filterMap(
            [
                await withBrowserbasePage(secretsClient, pageTask).catch((error: unknown) => {
                    log.error(error);
                    return ensureErrorAndPrependMessage(error, 'Browserbase failed');
                }),
                await withPlaywrightPage(pageTask).catch((error: unknown) => {
                    log.error(error);
                    return ensureErrorAndPrependMessage(error, 'Raw Playwright failed');
                }),
            ],
            (result) => result || undefined,
            check.isTruthy,
        );

        if (results.length) {
            throw combineErrors(results);
        }
    } finally {
        secretsClient.destroy();
    }
}

try {
    await wrapPromiseInTimeout(
        {
            minutes: 5,
        },
        runBotDetection(),
    );
    process.exit(0);
} catch (error) {
    log.error(error);
    process.exit(1);
}

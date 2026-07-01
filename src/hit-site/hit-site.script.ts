import {check} from '@augment-vir/assert';
import {
    combineErrors,
    ensureErrorAndPrependMessage,
    filterMap,
    log,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {parseArgs} from 'cli-vir';
import {type PageTask} from '../browser-runner.js';
import {withBrowserbasePage} from '../browserbase.js';
import {deleteScreenshots, screenshotPngPath} from '../file-paths.js';
import {navigateAndScreenshot} from '../navigate-and-screenshot.js';
import {withPlaywrightPage} from '../playwright.js';
import {createSecretsClient} from '../secrets.js';

async function main() {
    const args = parseArgs(
        process.argv,
        {
            url: {
                position: 0,
                required: true,
                description: 'The URL to navigate to and screenshot.',
            },
        },
        {
            binName: undefined,
            importMeta: import.meta,
            commandDescription:
                'Navigate to a URL through Browserbase and local Chromium and screenshot it.',
        },
    );

    await deleteScreenshots();

    const secretsClient = await createSecretsClient();

    const pageTask: PageTask<void> = async ({page, label}) => {
        await navigateAndScreenshot({
            page,
            url: args.url,
            screenshotPngPath: screenshotPngPath(label),
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
        main(),
    );
    process.exit(0);
} catch (error) {
    log.error(error);
    process.exit(1);
}

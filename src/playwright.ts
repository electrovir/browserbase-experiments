import {log} from '@augment-vir/common';
import {mkdir} from 'node:fs/promises';
import {viewportSize, type PageTask} from './browser-runner.js';
import {playwrightUserDataDirPath} from './file-paths.js';

export async function withPlaywrightPage<T>(task: PageTask<T>): Promise<T> {
    log.faint('Launching local Chrome...');
    await mkdir(playwrightUserDataDirPath, {
        recursive: true,
    });

    const browserContext = await (
        await import('@electrovir/rebrowser-playwright')
    ).chromium.launchPersistentContext(playwrightUserDataDirPath, {
        /** Use the installed stable Google Chrome instead of bundled Chromium (real user-agent). */
        channel: 'chrome',
        headless: false,
        acceptDownloads: true,
        args: [
            '--disable-blink-features=AutomationControlled',
        ],
        viewport: viewportSize,
    });
    browserContext.setDefaultTimeout(10_000);

    try {
        const page = browserContext.pages()[0] ?? (await browserContext.newPage());

        return await task({
            page,
            label: 'playwright',
        });
    } finally {
        await browserContext.close();
    }
}

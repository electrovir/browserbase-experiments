import {assert} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import Browserbase from '@browserbasehq/sdk';
import {viewportSize, type PageTask} from './browser-runner.js';
import {type SecretsClient} from './secrets.js';

const freeTier = false as boolean;

export async function withBrowserbasePage<T>(
    secretsClient: Readonly<SecretsClient>,
    task: PageTask<T>,
): Promise<T> {
    log.faint('Authenticating to Browserbase...');
    const browserbase = new Browserbase({
        apiKey: secretsClient.get.apiKey,
    });

    log.faint('Creating Browserbase session...');
    const session = await browserbase.sessions.create(
        freeTier
            ? {}
            : {
                  browserSettings: {
                      advancedStealth: true,
                      blockAds: true,
                      os: 'mac',
                      verified: true,
                      ignoreCertificateErrors: false,
                      /**
                       * Browserbase ignores this when `verified: true` is set. We manually fix it
                       * later.
                       */
                      //   viewport: viewportSize,
                      /**
                       * Default-on features that inject scripts into every page and bypass CSP to
                       * do so, which the detector's `bypassCsp` check flags. Disable them to keep
                       * CSP enforced.
                       */
                      solveCaptchas: false,
                      recordSession: false,
                  },
                  proxies: true,
              },
    );
    log.faint(`Browserbase session created: ${session.id}`);

    log.faint('Connecting via CDP...');
    const browser = await (
        await import('@electrovir/rebrowser-playwright')
    ).chromium.connectOverCDP(session.connectUrl);

    try {
        const context = browser.contexts()[0];
        assert.isDefined(context, 'Browserbase session returned no browser context.');

        const page = context.pages()[0];
        assert.isDefined(page, 'Browserbase session returned no page.');

        /**
         * Browserbase enables CSP bypass on its sessions (the detector's `bypassCsp` check flags
         * `Page.setBypassCSP`). Turn it back off over raw CDP before the task navigates, so pages
         * enforce their CSP like a normal browser. `Page.setBypassCSP` persists for the page across
         * navigation, so setting it once here covers the whole task.
         */
        const cdpSession = await context.newCDPSession(page);
        await cdpSession.send('Page.setBypassCSP', {
            enabled: false,
        });
        await cdpSession.detach();

        /** Browserbase ignores the `browserSettings.viewport`, so set it on the page directly. */
        await page.setViewportSize(viewportSize);

        return await task({
            page,
            label: 'browserbase',
        });
    } finally {
        await browser.close();
    }
}

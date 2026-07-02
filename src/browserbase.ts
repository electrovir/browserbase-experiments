import {assert, assertWrap} from '@augment-vir/assert';
import {log, wait} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import Browserbase from '@browserbasehq/sdk';
import {writeFile} from 'node:fs/promises';
import {viewportSize, type PageTask} from './browser-runner.js';
import {browserbaseContextIdPath, downloadOutputPath} from './file-paths.js';
import {type SecretsClient} from './secrets.js';

const freeTier = false as boolean;

const browserbaseApiOrigin = 'https://api.browserbase.com';

/** A single file Browserbase captured during a session, retrievable via its REST downloads API. */
type BrowserbaseDownload = {
    id: string;
    filename: string;
};

/**
 * Polls Browserbase's downloads API until the session has at least one captured file (the sync
 * happens asynchronously after the browser finishes downloading), then returns the file list.
 * Unlike the zip endpoint, each entry's `filename` is the original name without Browserbase's
 * timestamp suffix.
 */
async function listBrowserbaseDownloads({
    apiKey,
    sessionId,
    attemptsLeft = 30,
}: Readonly<{apiKey: string; sessionId: string; attemptsLeft?: number}>): Promise<
    BrowserbaseDownload[]
> {
    const listUrl = new URL('/v1/downloads', browserbaseApiOrigin);
    listUrl.searchParams.set('sessionId', sessionId);

    const response = await fetch(listUrl, {
        headers: {
            'x-bb-api-key': apiKey,
        },
    });
    if (!response.ok) {
        throw new Error(
            `Browserbase downloads list failed: ${response.status} ${response.statusText}.`,
        );
    }

    const body: {downloads: BrowserbaseDownload[]; total: number} = await response.json();
    if (body.total > 0 || attemptsLeft <= 1) {
        return body.downloads;
    }

    await wait({
        seconds: 1,
    });
    return await listBrowserbaseDownloads({
        apiKey,
        sessionId,
        attemptsLeft: attemptsLeft - 1,
    });
}

/** Retrieves a single Browserbase download's bytes by id. */
async function fetchBrowserbaseDownload({
    apiKey,
    downloadId,
}: Readonly<{apiKey: string; downloadId: string}>): Promise<Buffer> {
    const response = await fetch(`${browserbaseApiOrigin}/v1/downloads/${downloadId}`, {
        headers: {
            'x-bb-api-key': apiKey,
            Accept: 'application/octet-stream',
        },
    });
    if (!response.ok) {
        throw new Error(
            `Browserbase download fetch failed: ${response.status} ${response.statusText}.`,
        );
    }
    return Buffer.from(await response.arrayBuffer());
}

async function getOrCreateBrowserbaseContextId(browserbase: Browserbase): Promise<string> {
    const existingContextId = ((await readFileIfExists(browserbaseContextIdPath)) || '').trim();
    if (existingContextId) {
        log.faint(`Reusing Browserbase context: ${existingContextId}`);
        return existingContextId;
    }

    const context = await browserbase.contexts.create({});
    await writeFile(browserbaseContextIdPath, context.id);
    log.faint(`Created Browserbase context: ${context.id}`);
    return context.id;
}

export async function withBrowserbasePage<T>(
    secretsClient: Readonly<SecretsClient>,
    task: PageTask<T>,
): Promise<T> {
    log.faint('Authenticating to Browserbase...');
    const browserbase = new Browserbase({
        apiKey: secretsClient.get.apiKey,
    });

    const contextId = freeTier ? undefined : await getOrCreateBrowserbaseContextId(browserbase);

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
                      context: {
                          id: assertWrap.isDefined(
                              contextId,
                              'Browserbase context id was not resolved for a non-free-tier session.',
                          ),
                          persist: true,
                      },
                      /**
                       * Browserbase ignores this when `verified: true` is set. We manually fix it
                       * later.
                       */
                      //   viewport: viewportSize,
                  },
                  proxies: [
                      {
                          type: 'browserbase',
                          geolocation: {
                              country: 'US',
                              state: 'CA',
                          },
                      },
                  ],
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
            captureDownload: async (trigger) => {
                /**
                 * Route downloads into Browserbase's `downloads` path (must be exactly `downloads`)
                 * so it syncs them to session storage for retrieval via `sessions.downloads.list`.
                 * Do NOT detach this session: detaching reverts the download behavior to the
                 * default (deny), which blocks the download so no `download` event ever fires. The
                 * session is cleaned up when the browser closes.
                 */
                const downloadCdpSession = await context.newCDPSession(page);
                await downloadCdpSession.send('Browser.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: 'downloads',
                    eventsEnabled: true,
                });

                const [download] = await Promise.all([
                    page.waitForEvent('download', {
                        timeout: 30_000,
                    }),
                    trigger(),
                ]);
                log.faint(`Download started: ${download.suggestedFilename()}`);

                /**
                 * Wait for the download to actually finish on the remote browser before asking
                 * Browserbase for it. `download.failure()` resolves once the download completes
                 * (`null` on success), so it surfaces a failed download (e.g. a proxy-blocked
                 * fetch) that would otherwise silently produce an empty archive.
                 */
                const downloadFailure = await download.failure();
                if (downloadFailure) {
                    throw new Error(`Browserbase download did not complete: ${downloadFailure}`);
                }

                log.faint('Download complete; waiting for Browserbase to sync it to storage...');
                const downloads = await listBrowserbaseDownloads({
                    apiKey: secretsClient.get.apiKey,
                    sessionId: session.id,
                });
                if (!downloads.length) {
                    throw new Error(
                        'Browserbase reported no downloads; the download completed but never synced to session storage.',
                    );
                }

                const savedPaths = await Promise.all(
                    downloads.map(async (entry) => {
                        const fileBytes = await fetchBrowserbaseDownload({
                            apiKey: secretsClient.get.apiKey,
                            downloadId: entry.id,
                        });
                        const outputPath = downloadOutputPath({
                            label: 'browserbase',
                            fileName: entry.filename,
                        });
                        log.faint(`Saving Browserbase download to ${outputPath}...`);
                        await writeFile(outputPath, fileBytes);
                        return outputPath;
                    }),
                );
                return savedPaths.join(', ');
            },
        });
    } finally {
        await browser.close();
    }
}

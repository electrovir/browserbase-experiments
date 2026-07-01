import {filterMap} from '@augment-vir/common';
import {readdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';

export const repoDirPath = resolve(import.meta.dirname, '..');
export const notCommittedDirPath = join(repoDirPath, '.not-committed');
export const secretsJsonPath = join(notCommittedDirPath, 'secrets.json');
export const playwrightUserDataDirPath = join(notCommittedDirPath, 'playwright-user-data');

/** Screenshot output path for a given runner label (e.g. `browserbase`, `bot-detect-playwright`). */
export function screenshotPngPath(label: string): string {
    return join(notCommittedDirPath, `${label}.png`);
}

/** Deletes every screenshot (`.png`) in {@link notCommittedDirPath} so each run starts clean. */
export async function deleteScreenshots(): Promise<void> {
    const entries = await readdir(notCommittedDirPath).catch(() => []);
    const screenshotPaths = filterMap(
        entries,
        (entry) => join(notCommittedDirPath, entry),
        (path) => path.endsWith('.png'),
    );
    await Promise.all(screenshotPaths.map((path) => rm(path)));
}

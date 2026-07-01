import {type Page} from '@electrovir/rebrowser-playwright';

/** Shared, non-default (non-automation-looking) viewport applied by both runners. */
export const viewportSize = {
    width: 2560,
    height: 1335,
};

/** A live page handed to a task by a browser runner, tagged with which runner produced it. */
export type RunnerPage = Readonly<{
    page: Page;
    label: string;
}>;

/** Work to perform against a runner-provided {@link RunnerPage}. */
export type PageTask<T> = (runnerPage: RunnerPage) => Promise<T>;

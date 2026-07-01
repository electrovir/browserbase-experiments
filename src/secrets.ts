import {createUpdatingSecrets, defineSecrets, SecretsJsonFileAdapter} from 'updating-secrets';
import {secretsJsonPath} from './file-paths.js';

const browserbaseSecrets = defineSecrets({
    apiKey: {
        description: 'API key used to authenticate with Browserbase.',
        whereToFind: 'Browserbase dashboard > Settings > API Keys.',
    },
});

export async function createSecretsClient() {
    return await createUpdatingSecrets(browserbaseSecrets, [
        new SecretsJsonFileAdapter(secretsJsonPath, {
            generateValues() {
                return {};
            },
        }),
    ]);
}

export type SecretsClient = Awaited<ReturnType<typeof createSecretsClient>>;

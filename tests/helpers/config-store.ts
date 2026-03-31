import {
	configStore,
	getExperimentalOverride,
	getConfigDirPath,
	maskApiKey,
	type NiaConfig,
	persistExperimentalPreference,
	resolveApiKey,
	resolveBaseUrl,
	setExperimentalOverride,
} from "../../src/services/config.ts";

export {
	getConfigDirPath,
	maskApiKey,
	persistExperimentalPreference,
	resolveApiKey,
	resolveBaseUrl,
	getExperimentalOverride,
	setExperimentalOverride,
};

type LegacyConfig = Omit<NiaConfig, "useExperimentalApi"> & {
	useExperimentalApi?: boolean;
	output?: string;
};

function withDefaults(config: LegacyConfig): NiaConfig {
	return {
		...config,
		useExperimentalApi: config.useExperimentalApi ?? false,
	};
}

export async function readConfig(): Promise<LegacyConfig> {
	return (await configStore.read()) as LegacyConfig;
}

export async function writeConfig(config: LegacyConfig): Promise<void> {
	const { output: _output, ...next } = config;
	return configStore.write(withDefaults(next as LegacyConfig));
}

export async function updateConfig(
	updater: (current: LegacyConfig) => LegacyConfig,
): Promise<void> {
	return configStore.update((current) => {
		const next = updater(current as LegacyConfig);
		const { output: _output, ...persisted } = next;
		return withDefaults(persisted as LegacyConfig);
	});
}

export async function resetConfig(): Promise<void> {
	return configStore.reset();
}

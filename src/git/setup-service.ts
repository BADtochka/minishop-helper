import type { GitProvider } from "./provider";
import type { GitRepository } from "./types";
import { RepositoryBindingRepository, type StoredRepository } from "../storage/repository-bindings";
import { reportProgress, type ProgressReporter } from "../progress";

export type ProviderResolver = (ownerTelegramId: number, provider: string) => Promise<GitProvider | undefined>;

export class RepositorySetupService {
  constructor(private readonly repositories: RepositoryBindingRepository, private readonly resolveProvider: ProviderResolver, private readonly onSelected?: (stored: StoredRepository, repository: GitRepository, provider: GitProvider) => Promise<void>) {}

  async list(ownerTelegramId: number, provider: string, progress?: ProgressReporter): Promise<GitRepository[]> {
    this.requireConnection(ownerTelegramId, provider);
    const client = await this.resolveProvider(ownerTelegramId, provider);
    if (!client) throw new Error(`${provider} provider is not available`);
    await reportProgress(progress, "⏳ Запрашиваю список репозиториев...");
    return client.listRepositories();
  }

  async select(ownerTelegramId: number, chatId: string, provider: string, providerRepositoryId: string): Promise<StoredRepository> {
    const repository = await this.prepare(ownerTelegramId, provider, providerRepositoryId);
    this.repositories.bind(chatId, repository.id, null, repository.defaultBranch);
    return repository;
  }

  async listBranches(ownerTelegramId: number, provider: string, providerRepositoryId: string, progress?: ProgressReporter): Promise<{ repository: StoredRepository; branches: string[] }> {
    const repository = await this.prepare(ownerTelegramId, provider, providerRepositoryId, progress);
    const client = await this.resolveProvider(ownerTelegramId, provider);
    if (!client) throw new Error(`${provider} provider is not available`);
    await reportProgress(progress, "⏳ Запрашиваю список веток...");
    const branches = [...new Set(await client.listBranches(toGitRepository(repository)))];
    if (branches.length) return { repository, branches };
    if (repository.defaultBranch) return { repository, branches: [repository.defaultBranch] };
    throw new Error("Provider did not return branches or a default branch");
  }

  async prepare(ownerTelegramId: number, provider: string, providerRepositoryId: string, progress?: ProgressReporter): Promise<StoredRepository> {
    const connection = this.requireConnection(ownerTelegramId, provider);
    const client = await this.resolveProvider(ownerTelegramId, provider);
    if (!client) throw new Error(`${provider} provider is not available`);
    await reportProgress(progress, "⏳ Проверяю доступ к репозиторию...");
    const selected = (await client.listRepositories()).find((repository) => String(repository.id) === String(providerRepositoryId));
    if (!selected) throw new Error("Repository is not available to this connection");
    const repository = this.repositories.saveRepository(connection.id, {
      providerRepositoryId: selected.id,
      fullName: selected.fullName,
      defaultBranch: selected.defaultBranch,
      webUrl: selected.webUrl,
    });
    try {
      await reportProgress(progress, "⏳ Собираю контекст проекта...");
      await this.onSelected?.(repository, selected, client);
    } catch {
      // Context enrichment is optional and must not roll back a valid repository selection.
      await reportProgress(progress, "⚠️ Репозиторий сохранён, но контекст пока не обновлён.");
    }
    return repository;
  }

  private requireConnection(ownerTelegramId: number, provider: string): { id: string } {
    const connection = this.repositories.resolveConnection(ownerTelegramId, provider);
    if (!connection) throw new Error(`${provider} is not connected`);
    return connection;
  }
}

function toGitRepository(repository: StoredRepository): GitRepository {
  const separator = repository.fullName.lastIndexOf("/");
  return { id: repository.providerRepositoryId, owner: separator < 0 ? "" : repository.fullName.slice(0, separator), name: separator < 0 ? repository.fullName : repository.fullName.slice(separator + 1), fullName: repository.fullName, description: null, private: false, webUrl: repository.webUrl ?? "", defaultBranch: repository.defaultBranch };
}

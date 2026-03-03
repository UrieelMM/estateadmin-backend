import * as XLSX from 'xlsx';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { UpsertCondominiumUsersCase } from './upsert-condominiums.case';

class FakeDocSnapshot {
  constructor(
    public readonly id: string,
    private readonly payload: any,
    public readonly exists: boolean,
  ) {}

  data() {
    return this.payload;
  }
}

class FakeDocRef {
  constructor(
    private readonly db: FakeFirestore,
    public readonly path: string,
    public readonly id: string,
  ) {}

  async get() {
    if (!this.db.docs.has(this.path)) {
      return new FakeDocSnapshot(this.id, undefined, false);
    }
    return new FakeDocSnapshot(this.id, this.db.docs.get(this.path), true);
  }

  async set(data: any, options?: { merge?: boolean }) {
    if (options?.merge && this.db.docs.has(this.path)) {
      const current = this.db.docs.get(this.path) || {};
      this.db.docs.set(this.path, { ...current, ...data });
      return;
    }

    this.db.docs.set(this.path, { ...data });
  }
}

class FakeCollectionRef {
  constructor(
    private readonly db: FakeFirestore,
    private readonly collectionPath: string,
  ) {}

  doc(id?: string) {
    const resolvedId = id || this.db.nextId(this.collectionPath);
    return new FakeDocRef(
      this.db,
      `${this.collectionPath}/${resolvedId}`,
      resolvedId,
    );
  }

  async get() {
    const prefix = `${this.collectionPath}/`;
    const docs = Array.from(this.db.docs.entries())
      .filter(([path]) => {
        if (!path.startsWith(prefix)) {
          return false;
        }
        const tail = path.slice(prefix.length);
        return !tail.includes('/');
      })
      .map(([path, payload]) => {
        const id = path.split('/').pop() || '';
        return new FakeDocSnapshot(id, payload, true);
      });

    return { docs };
  }

  async add(data: any) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class FakeFirestore {
  docs = new Map<string, any>();
  private counters = new Map<string, number>();

  collection(path: string) {
    return new FakeCollectionRef(this, path);
  }

  bulkWriter() {
    return {
      set: (docRef: FakeDocRef, data: any, options?: { merge?: boolean }) =>
        docRef.set(data, options),
      close: async () => undefined,
    };
  }

  nextId(path: string) {
    const current = this.counters.get(path) || 0;
    const next = current + 1;
    this.counters.set(path, next);
    return `auto_${next}`;
  }
}

const createExcelBuffer = (rows: Record<string, any>[]) => {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Usuarios');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

describe('UpsertCondominiumUsersCase integration', () => {
  let firestore: FakeFirestore;
  let useCase: UpsertCondominiumUsersCase;

  beforeEach(() => {
    firestore = new FakeFirestore();
    useCase = new UpsertCondominiumUsersCase(firestore as any);

    firestore.docs.set('clients/c1/condominiums/condo1', {
      name: 'Condo 1',
    });

    firestore.docs.set('clients/c1/condominiums/condo1/users/u1', {
      uid: 'u1',
      name: 'Ana',
      email: 'ana@test.com',
      number: '101',
      tower: 'A',
      role: 'user',
    });
  });

  it('dry-run no escribe usuarios y sí crea operationId temporal', async () => {
    const beforeUsers = Array.from(firestore.docs.keys()).filter((path) =>
      path.startsWith('clients/c1/condominiums/condo1/users/'),
    ).length;

    const file = createExcelBuffer([
      {
        name: 'Ana',
        lastName: 'Perez',
        email: 'ana@test.com',
        number: '101',
        tower: 'A',
      },
    ]);

    const result = await useCase.executeDryRun({
      fileBuffer: file,
      originalFileName: 'users.xlsx',
      clientId: 'c1',
      condominiumId: 'condo1',
      mode: 'upsert',
      actor: {
        uid: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        clientId: 'c1',
      },
      sourceIp: '127.0.0.1',
    });

    const afterUsers = Array.from(firestore.docs.keys()).filter((path) =>
      path.startsWith('clients/c1/condominiums/condo1/users/'),
    ).length;

    expect(afterUsers).toBe(beforeUsers);
    expect(result.ok).toBe(true);
    expect(result.operationId).toBeDefined();

    const operationPath = `clients/c1/condominiums/condo1/importOperations/${result.operationId}`;
    expect(firestore.docs.has(operationPath)).toBe(true);
  });

  it('tenant isolation: falla si condominio no pertenece al cliente', async () => {
    await expect(
      useCase.assertCondominiumInClient('c1', 'missing-condo'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('commit falla si hash del archivo no coincide con dry-run', async () => {
    const baseFile = createExcelBuffer([
      {
        name: 'Ana',
        email: 'ana@test.com',
        number: '101',
        tower: 'A',
      },
    ]);

    const dryRun = await useCase.executeDryRun({
      fileBuffer: baseFile,
      originalFileName: 'users.xlsx',
      clientId: 'c1',
      condominiumId: 'condo1',
      mode: 'upsert',
      actor: {
        uid: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        clientId: 'c1',
      },
    });

    const differentFile = createExcelBuffer([
      {
        name: 'Nuevo',
        email: 'nuevo@test.com',
        number: '999',
        tower: 'Z',
      },
    ]);

    await expect(
      useCase.executeCommit({
        fileBuffer: differentFile,
        originalFileName: 'users.xlsx',
        clientId: 'c1',
        condominiumId: 'condo1',
        operationId: dryRun.operationId,
        actor: {
          uid: 'admin-1',
          email: 'admin@test.com',
          role: 'admin',
          clientId: 'c1',
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('commit falla cuando operationId está expirado', async () => {
    const file = createExcelBuffer([
      {
        name: 'Ana',
        email: 'ana@test.com',
        number: '101',
        tower: 'A',
      },
    ]);

    const dryRun = await useCase.executeDryRun({
      fileBuffer: file,
      originalFileName: 'users.xlsx',
      clientId: 'c1',
      condominiumId: 'condo1',
      mode: 'upsert',
      actor: {
        uid: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        clientId: 'c1',
      },
    });

    const operationPath = `clients/c1/condominiums/condo1/importOperations/${dryRun.operationId}`;
    const operationData = firestore.docs.get(operationPath);
    firestore.docs.set(operationPath, {
      ...operationData,
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    await expect(
      useCase.executeCommit({
        fileBuffer: file,
        originalFileName: 'users.xlsx',
        clientId: 'c1',
        condominiumId: 'condo1',
        operationId: dryRun.operationId,
        actor: {
          uid: 'admin-1',
          email: 'admin@test.com',
          role: 'admin',
          clientId: 'c1',
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

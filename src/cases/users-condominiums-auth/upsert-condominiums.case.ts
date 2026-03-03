import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as XLSX from 'xlsx';
import { createHash } from 'crypto';
import { basename, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  UpsertActor,
  UpsertCondominiumUsersOptions,
  UpsertMatchBy,
  UpsertMode,
} from 'src/dtos/upsert-condominium-users.dto';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const OPERATION_TTL_MINUTES = 15;
const WRITE_CHUNK_SIZE = 400;
const WRITE_CHUNK_TIMEOUT_MS = 60_000;

const ALLOWED_CONDOMINIUM_ROLES = new Set(['propietario', 'inquilino']);

const DEFAULT_OPTIONS: UpsertCondominiumUsersOptions = {
  skipEmptyUpdates: true,
  matchBy: 'auto',
  allowRoleUpdate: false,
  allowEmailUpdate: false,
  allowNumberUpdate: true,
};

type EditableField = keyof Omit<NormalizedImportRow, 'rowNumber'>;

const EDITABLE_FIELDS: EditableField[] = [
  'name',
  'lastName',
  'email',
  'role',
  'CP',
  'address',
  'country',
  'city',
  'state',
  'number',
  'tower',
  'busisnessName',
  'taxResidence',
  'taxRegime',
  'departament',
  'photoURL',
  'RFC',
  'phone',
];

type RowAction = 'create' | 'update' | 'skip' | 'error';
type MatchStrategy = 'email' | 'number_tower' | 'number' | 'none';

interface ExistingUserRecord {
  id: string;
  raw: Record<string, any>;
}

interface NormalizedImportRow {
  rowNumber: number;
  name: string;
  lastName: string;
  email: string;
  role: string;
  CP: string;
  address: string;
  country: string;
  city: string;
  state: string;
  number: string;
  tower: string;
  busisnessName: string;
  taxResidence: string;
  taxRegime: string;
  departament: string;
  photoURL: string;
  RFC: string;
  phone: string;
}

interface ResolvedMatch {
  user: ExistingUserRecord | null;
  strategy: MatchStrategy;
  reasons: string[];
  isAmbiguous: boolean;
}

interface InternalRowPlan {
  rowNumber: number;
  action: RowAction;
  matchStrategy: MatchStrategy;
  reasons: string[];
  normalizedPayload: Record<string, string>;
  matchedUserId?: string;
  writePayload?: Record<string, any>;
}

interface UpsertPlan {
  rows: InternalRowPlan[];
  summary: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    willCreate: number;
    willUpdate: number;
    willSkip: number;
  };
}

interface DryRunInput {
  fileBuffer: Buffer;
  originalFileName?: string;
  clientId: string;
  condominiumId: string;
  mode?: UpsertMode;
  optionsJson?: string;
  actor: UpsertActor;
  sourceIp?: string;
}

interface CommitInput {
  fileBuffer: Buffer;
  originalFileName?: string;
  clientId: string;
  condominiumId: string;
  operationId: string;
  actor: UpsertActor;
  sourceIp?: string;
}

interface ImportOperationDoc {
  operationId: string;
  clientId: string;
  condominiumId: string;
  mode: UpsertMode;
  options: UpsertCondominiumUsersOptions;
  fileHash: string;
  planHash: string;
  dryRunSummary: UpsertPlan['summary'];
  createdByUid: string;
  createdByEmail: string;
  createdAt: admin.firestore.FieldValue;
  expiresAt: admin.firestore.Timestamp;
  status: 'dry_run' | 'committed';
  sourceIp?: string;
}

interface PendingWrite {
  row: InternalRowPlan;
  action: 'create' | 'update';
  ref: admin.firestore.DocumentReference;
  payload: Record<string, any>;
}

const HEADER_MAP: Record<string, keyof Omit<NormalizedImportRow, 'rowNumber'>> = {
  name: 'name',
  lastname: 'lastName',
  email: 'email',
  role: 'role',
  cp: 'CP',
  address: 'address',
  country: 'country',
  city: 'city',
  state: 'state',
  number: 'number',
  tower: 'tower',
  busisnessname: 'busisnessName',
  businessname: 'busisnessName',
  taxresidence: 'taxResidence',
  taxregime: 'taxRegime',
  taxtregime: 'taxRegime',
  departament: 'departament',
  department: 'departament',
  photourl: 'photoURL',
  rfc: 'RFC',
  phone: 'phone',
};

const EMPTY_NORMALIZED_ROW: Omit<NormalizedImportRow, 'rowNumber'> = {
  name: '',
  lastName: '',
  email: '',
  role: '',
  CP: '',
  address: '',
  country: '',
  city: '',
  state: '',
  number: '',
  tower: '',
  busisnessName: '',
  taxResidence: '',
  taxRegime: '',
  departament: '',
  photoURL: '',
  RFC: '',
  phone: '',
};

export const normalizeText = (value: unknown): string =>
  String(value ?? '').trim();

export const normalizeEmail = (value: unknown): string =>
  normalizeText(value).toLowerCase();

const normalizeHeader = (value: string): string =>
  value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

const resolveResidentRole = (
  role: string,
): { role: string; isValid: boolean } => {
  const normalizedRole = normalizeText(role).toLowerCase();
  const resolvedRole = normalizedRole || 'propietario';

  return {
    role: resolvedRole,
    isValid: ALLOWED_CONDOMINIUM_ROLES.has(resolvedRole),
  };
};

const getComparableCurrentValue = (
  user: ExistingUserRecord,
  field: EditableField,
): string => {
  if (field === 'busisnessName') {
    return normalizeText(user.raw.busisnessName || user.raw.businessName);
  }
  if (field === 'email') {
    return normalizeEmail(user.raw.email);
  }
  return normalizeText(user.raw[field]);
};

export const parseUpsertOptions = (
  rawOptions?: string,
): UpsertCondominiumUsersOptions => {
  if (!rawOptions) {
    return { ...DEFAULT_OPTIONS };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawOptions);
  } catch {
    throw new BadRequestException('El campo options debe ser JSON válido.');
  }

  const options: UpsertCondominiumUsersOptions = {
    skipEmptyUpdates:
      typeof parsed.skipEmptyUpdates === 'boolean'
        ? parsed.skipEmptyUpdates
        : DEFAULT_OPTIONS.skipEmptyUpdates,
    matchBy:
      parsed.matchBy === 'email' ||
      parsed.matchBy === 'number_tower' ||
      parsed.matchBy === 'auto'
        ? parsed.matchBy
        : DEFAULT_OPTIONS.matchBy,
    allowRoleUpdate:
      typeof parsed.allowRoleUpdate === 'boolean'
        ? parsed.allowRoleUpdate
        : DEFAULT_OPTIONS.allowRoleUpdate,
    allowEmailUpdate:
      typeof parsed.allowEmailUpdate === 'boolean'
        ? parsed.allowEmailUpdate
        : DEFAULT_OPTIONS.allowEmailUpdate,
    allowNumberUpdate:
      typeof parsed.allowNumberUpdate === 'boolean'
        ? parsed.allowNumberUpdate
        : DEFAULT_OPTIONS.allowNumberUpdate,
  };

  return options;
};

const mapAndNormalizeRow = (
  row: Record<string, any>,
  rowNumber: number,
): NormalizedImportRow => {
  const normalizedRow: NormalizedImportRow = {
    rowNumber,
    ...EMPTY_NORMALIZED_ROW,
  };

  Object.entries(row).forEach(([rawHeader, rawValue]) => {
    const mappedField = HEADER_MAP[normalizeHeader(rawHeader)];
    if (!mappedField) {
      return;
    }

    if (mappedField === 'email') {
      normalizedRow.email = normalizeEmail(rawValue);
      return;
    }

    normalizedRow[mappedField] = normalizeText(rawValue);
  });

  return normalizedRow;
};

const buildSafePayload = (row: NormalizedImportRow): Record<string, string> => ({
  name: row.name,
  lastName: row.lastName,
  email: row.email,
  role: row.role,
  number: row.number,
  tower: row.tower,
  city: row.city,
  state: row.state,
  country: row.country,
});

const buildExistingIndexes = (users: ExistingUserRecord[]) => {
  const byEmail = new Map<string, ExistingUserRecord[]>();
  const byNumberTower = new Map<string, ExistingUserRecord[]>();
  const byNumber = new Map<string, ExistingUserRecord[]>();

  users.forEach((user) => {
    const email = normalizeEmail(user.raw.email);
    const number = normalizeText(user.raw.number);
    const tower = normalizeText(user.raw.tower);

    if (email) {
      const list = byEmail.get(email) || [];
      list.push(user);
      byEmail.set(email, list);
    }

    if (number) {
      const byNumberList = byNumber.get(number) || [];
      byNumberList.push(user);
      byNumber.set(number, byNumberList);

      if (tower) {
        const key = `${number}::${tower}`;
        const byNumberTowerList = byNumberTower.get(key) || [];
        byNumberTowerList.push(user);
        byNumberTower.set(key, byNumberTowerList);
      }
    }
  });

  return { byEmail, byNumberTower, byNumber };
};

const resolveMatch = (
  row: NormalizedImportRow,
  matchBy: UpsertMatchBy,
  indexes: ReturnType<typeof buildExistingIndexes>,
): ResolvedMatch => {
  const checkResult = (
    strategy: MatchStrategy,
    matches: ExistingUserRecord[] | undefined,
  ): ResolvedMatch => {
    if (!matches || matches.length === 0) {
      return { user: null, strategy, reasons: [], isAmbiguous: false };
    }

    if (matches.length > 1) {
      return {
        user: null,
        strategy,
        reasons: [
          `Fila ambigua: se encontraron ${matches.length} coincidencias por ${strategy}.`,
        ],
        isAmbiguous: true,
      };
    }

    return { user: matches[0], strategy, reasons: [], isAmbiguous: false };
  };

  if (matchBy === 'email') {
    if (!row.email) {
      return {
        user: null,
        strategy: 'none',
        reasons: ['No se puede hacer matchBy=email sin email.'],
        isAmbiguous: false,
      };
    }

    return checkResult('email', indexes.byEmail.get(row.email));
  }

  if (matchBy === 'number_tower') {
    if (!row.number || !row.tower) {
      return {
        user: null,
        strategy: 'none',
        reasons: ['No se puede hacer matchBy=number_tower sin number y tower.'],
        isAmbiguous: false,
      };
    }

    return checkResult(
      'number_tower',
      indexes.byNumberTower.get(`${row.number}::${row.tower}`),
    );
  }

  if (row.email) {
    const emailResolved = checkResult('email', indexes.byEmail.get(row.email));
    if (emailResolved.user || emailResolved.isAmbiguous) {
      return emailResolved;
    }
  }

  if (row.number && row.tower) {
    const numberTowerResolved = checkResult(
      'number_tower',
      indexes.byNumberTower.get(`${row.number}::${row.tower}`),
    );
    if (numberTowerResolved.user || numberTowerResolved.isAmbiguous) {
      return numberTowerResolved;
    }
  }

  if (row.number) {
    const numberResolved = checkResult('number', indexes.byNumber.get(row.number));
    if (numberResolved.user || numberResolved.isAmbiguous) {
      return numberResolved;
    }
  }

  return { user: null, strategy: 'none', reasons: [], isAmbiguous: false };
};

const buildCreatePayload = (
  row: NormalizedImportRow,
): Record<string, string | boolean> => {
  const payload: Record<string, string | boolean> = {};

  EDITABLE_FIELDS.forEach((field) => {
    const value = row[field] || '';
    if (!value) {
      return;
    }
    payload[field] = value;
  });

  payload.role = row.role || 'propietario';
  payload.active = true;

  return payload;
};

const buildUpdatePayload = (
  row: NormalizedImportRow,
  matchedUser: ExistingUserRecord,
  options: UpsertCondominiumUsersOptions,
): Record<string, string> => {
  const payload: Record<string, string> = {};

  EDITABLE_FIELDS.forEach((field) => {
    if (field === 'email' && !options.allowEmailUpdate) {
      return;
    }

    if (field === 'role' && !options.allowRoleUpdate) {
      return;
    }

    if (field === 'number' && !options.allowNumberUpdate) {
      return;
    }

    const incomingValue = row[field] || '';
    if (!incomingValue && options.skipEmptyUpdates) {
      return;
    }

    const currentValue = getComparableCurrentValue(matchedUser, field);
    const comparableIncoming = field === 'email' ? normalizeEmail(incomingValue) : incomingValue;

    if (comparableIncoming === currentValue) {
      return;
    }

    payload[field] = incomingValue;
  });

  return payload;
};

export const buildUpsertPlan = (params: {
  rows: NormalizedImportRow[];
  existingUsers: ExistingUserRecord[];
  mode: UpsertMode;
  options: UpsertCondominiumUsersOptions;
}): UpsertPlan => {
  const { rows, existingUsers, mode, options } = params;
  const indexes = buildExistingIndexes(existingUsers);

  const plans: InternalRowPlan[] = rows.map((row) => {
    const roleResolution = resolveResidentRole(row.role);
    const normalizedRow: NormalizedImportRow = {
      ...row,
      role: roleResolution.role,
    };

    const reasons: string[] = [];
    const safePayload = buildSafePayload(normalizedRow);

    if (!normalizedRow.name) {
      reasons.push('El campo name es obligatorio.');
    }

    if (!roleResolution.isValid) {
      reasons.push(
        `Role inválido: ${row.role}. Valores permitidos: propietario, inquilino.`,
      );
    }

    const matched = resolveMatch(normalizedRow, options.matchBy, indexes);
    reasons.push(...matched.reasons);

    if (reasons.length > 0 || matched.isAmbiguous) {
      return {
        rowNumber: row.rowNumber,
        action: 'error',
        matchStrategy: matched.strategy,
        reasons,
        normalizedPayload: safePayload,
        matchedUserId: matched.user?.id,
      };
    }

    if (mode === 'create_only' && matched.user) {
      return {
        rowNumber: row.rowNumber,
        action: 'skip',
        matchStrategy: matched.strategy,
        reasons: ['Registro omitido por mode=create_only (ya existe usuario).'],
        normalizedPayload: safePayload,
        matchedUserId: matched.user.id,
      };
    }

    if (mode === 'update_only' && !matched.user) {
      return {
        rowNumber: row.rowNumber,
        action: 'skip',
        matchStrategy: matched.strategy,
        reasons: ['Registro omitido por mode=update_only (no existe usuario).'],
        normalizedPayload: safePayload,
      };
    }

    if (matched.user) {
      const updatePayload = buildUpdatePayload(
        normalizedRow,
        matched.user,
        options,
      );
      if (Object.keys(updatePayload).length === 0) {
        return {
          rowNumber: row.rowNumber,
          action: 'skip',
          matchStrategy: matched.strategy,
          reasons: ['No hay cambios aplicables para actualizar.'],
          normalizedPayload: safePayload,
          matchedUserId: matched.user.id,
        };
      }

      return {
        rowNumber: row.rowNumber,
        action: 'update',
        matchStrategy: matched.strategy,
        reasons: [],
        normalizedPayload: safePayload,
        matchedUserId: matched.user.id,
        writePayload: updatePayload,
      };
    }

    return {
      rowNumber: row.rowNumber,
      action: 'create',
      matchStrategy: matched.strategy,
      reasons: [],
      normalizedPayload: safePayload,
      writePayload: buildCreatePayload(normalizedRow),
    };
  });

  const summary = {
    totalRows: plans.length,
    validRows: plans.filter((row) => row.action !== 'error').length,
    errorRows: plans.filter((row) => row.action === 'error').length,
    willCreate: plans.filter((row) => row.action === 'create').length,
    willUpdate: plans.filter((row) => row.action === 'update').length,
    willSkip: plans.filter((row) => row.action === 'skip').length,
  };

  return {
    rows: plans,
    summary,
  };
};

const toDate = (value: unknown): Date | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if ((value as any)?.toDate && typeof (value as any).toDate === 'function') {
    return (value as any).toDate();
  }

  return null;
};

@Injectable()
export class UpsertCondominiumUsersCase {
  private readonly logger = new Logger(UpsertCondominiumUsersCase.name);
  private readonly firestore: admin.firestore.Firestore;

  constructor(@Optional() firestore?: admin.firestore.Firestore) {
    this.firestore = firestore || admin.firestore();
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(timeoutMessage));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async assertCondominiumInClient(
    clientId: string,
    condominiumId: string,
  ): Promise<void> {
    const condominiumRef = this.firestore
      .collection(`clients/${clientId}/condominiums`)
      .doc(condominiumId);

    const condominiumSnap = await condominiumRef.get();
    if (!condominiumSnap.exists) {
      throw new NotFoundException('Condominio no encontrado para este cliente.');
    }
  }

  async executeDryRun(input: DryRunInput) {
    try {
      const mode: UpsertMode = input.mode || 'upsert';
      const options = parseUpsertOptions(input.optionsJson);

      this.logger.log(
        `[upsert.case][dry-run] Inicio clientId=${input.clientId} condominiumId=${input.condominiumId} mode=${mode} actor=${input.actor.uid}`,
      );

      this.validateClientAndCondominium(input.clientId, input.condominiumId);
      this.validateFile(input.fileBuffer, input.originalFileName);
      await this.assertCondominiumInClient(input.clientId, input.condominiumId);

      const fileHash = this.getFileHash(input.fileBuffer);
      const rows = this.parseExcelRows(input.fileBuffer);
      const existingUsers = await this.loadExistingUsers(
        input.clientId,
        input.condominiumId,
      );

      this.logger.log(
        `[upsert.case][dry-run] Datos cargados rows=${rows.length} existingUsers=${existingUsers.length}`,
      );

      const plan = buildUpsertPlan({ rows, existingUsers, mode, options });
      const operationId = uuidv4();
      const expiresAt = new Date(Date.now() + OPERATION_TTL_MINUTES * 60_000);
      const planHash = this.getPlanHash(plan);

      await this.firestore
        .collection(
          `clients/${input.clientId}/condominiums/${input.condominiumId}/importOperations`,
        )
        .doc(operationId)
        .set({
          operationId,
          clientId: input.clientId,
          condominiumId: input.condominiumId,
          mode,
          options,
          fileHash,
          planHash,
          dryRunSummary: plan.summary,
          createdByUid: input.actor.uid,
          createdByEmail: input.actor.email,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
          status: 'dry_run',
          sourceIp: input.sourceIp || null,
        } as ImportOperationDoc);

      this.logger.log(
        `[upsert.case][dry-run] Finalizado operationId=${operationId} totalRows=${plan.summary.totalRows} willCreate=${plan.summary.willCreate} willUpdate=${plan.summary.willUpdate} willSkip=${plan.summary.willSkip} errors=${plan.summary.errorRows}`,
      );

      return {
        ok: true,
        operationId,
        expiresAt: expiresAt.toISOString(),
        mode,
        options,
        fileHash,
        summary: plan.summary,
        rows: plan.rows.map((row) => ({
          rowNumber: row.rowNumber,
          action: row.action,
          matchStrategy: row.matchStrategy,
          reasons: row.reasons,
          normalizedPayload: row.normalizedPayload,
          matchedUserId: row.matchedUserId || null,
        })),
      };
    } catch (error) {
      this.logger.error(
        `[upsert.case][dry-run] Error clientId=${input.clientId} condominiumId=${input.condominiumId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async executeCommit(input: CommitInput) {
    try {
      this.logger.log(
        `[upsert.case][commit] Inicio operationId=${input.operationId} clientId=${input.clientId} condominiumId=${input.condominiumId} actor=${input.actor.uid}`,
      );

      this.validateClientAndCondominium(input.clientId, input.condominiumId);
      this.validateFile(input.fileBuffer, input.originalFileName);
      await this.assertCondominiumInClient(input.clientId, input.condominiumId);

      const operationRef = this.firestore
        .collection(
          `clients/${input.clientId}/condominiums/${input.condominiumId}/importOperations`,
        )
        .doc(input.operationId);

      const operationSnap = await operationRef.get();
      if (!operationSnap.exists) {
        throw new NotFoundException('operationId no encontrado.');
      }

      const operation = operationSnap.data() as ImportOperationDoc;
      if (!operation) {
        throw new NotFoundException('operationId inválido.');
      }

      if (
        operation.clientId !== input.clientId ||
        operation.condominiumId !== input.condominiumId
      ) {
        throw new ConflictException('La operación no corresponde al tenant enviado.');
      }

      if (operation.createdByUid !== input.actor.uid) {
        throw new ForbiddenException('La operación fue creada por otro usuario.');
      }

      const expiresAtDate = toDate(operation.expiresAt);
      if (!expiresAtDate || expiresAtDate.getTime() <= Date.now()) {
        throw new ConflictException('operationId expirado, ejecuta dry-run nuevamente.');
      }

      const fileHash = this.getFileHash(input.fileBuffer);
      if (operation.fileHash !== fileHash) {
        throw new ConflictException('El archivo no coincide con el dry-run.');
      }

      const rows = this.parseExcelRows(input.fileBuffer);
      const existingUsers = await this.loadExistingUsers(
        input.clientId,
        input.condominiumId,
      );
      const plan = buildUpsertPlan({
        rows,
        existingUsers,
        mode: operation.mode,
        options: operation.options,
      });

      this.logger.log(
        `[upsert.case][commit] Plan reconstruido rows=${rows.length} willCreate=${plan.summary.willCreate} willUpdate=${plan.summary.willUpdate} willSkip=${plan.summary.willSkip} errors=${plan.summary.errorRows}`,
      );

      const planHash = this.getPlanHash(plan);
      if (operation.planHash !== planHash) {
        throw new ConflictException(
          'El estado de usuarios cambió desde el dry-run, vuelve a ejecutar dry-run.',
        );
      }

      const usersRef = this.firestore.collection(
        `clients/${input.clientId}/condominiums/${input.condominiumId}/users`,
      );
      const nowTimestamp = admin.firestore.FieldValue.serverTimestamp();
      const commitRowsMap = new Map<number, any>();
      const pendingWrites: PendingWrite[] = [];

      plan.rows.forEach((row) => {
      if (row.action === 'error' || row.action === 'skip') {
        commitRowsMap.set(row.rowNumber, {
          rowNumber: row.rowNumber,
          action: row.action,
          status: row.action,
          reason: row.reasons.join(' | ') || '',
          matchedUserId: row.matchedUserId || '',
          createdUserId: '',
          email: row.normalizedPayload.email || '',
          number: row.normalizedPayload.number || '',
          tower: row.normalizedPayload.tower || '',
          name: row.normalizedPayload.name || '',
        });
        return;
      }

      if (row.action === 'create') {
        const newUserRef = usersRef.doc();
        const createPayload = {
          ...(row.writePayload || {}),
          uid: newUserRef.id,
          clientId: input.clientId,
          condominiumId: input.condominiumId,
          importOperationId: input.operationId,
          createdDate: nowTimestamp,
          updatedAt: nowTimestamp,
          updatedBy: input.actor.uid,
        };
        pendingWrites.push({
          row,
          action: 'create',
          ref: newUserRef,
          payload: createPayload,
        });
        return;
      }

      if (row.action === 'update' && row.matchedUserId) {
        const userRef = usersRef.doc(row.matchedUserId);
        const updatePayload = {
          ...(row.writePayload || {}),
          updatedAt: nowTimestamp,
          updatedBy: input.actor.uid,
          importOperationId: input.operationId,
        };
        pendingWrites.push({
          row,
          action: 'update',
          ref: userRef,
          payload: updatePayload,
        });
      }
      });
      this.logger.log(
        `[upsert.case][commit] Iniciando escritura pendingWrites=${pendingWrites.length} chunkSize=${WRITE_CHUNK_SIZE}`,
      );

      for (let i = 0; i < pendingWrites.length; i += WRITE_CHUNK_SIZE) {
        const chunk = pendingWrites.slice(i, i + WRITE_CHUNK_SIZE);
        const chunkStart = i + 1;
        const chunkEnd = i + chunk.length;
        const chunkLabel = `${chunkStart}-${chunkEnd}`;
        this.logger.log(
          `[upsert.case][commit] Escribiendo chunk ${chunkLabel} de ${pendingWrites.length}`,
        );

        const batch = this.firestore.batch();
        chunk.forEach((writeOp) => {
          if (writeOp.action === 'update') {
            batch.set(writeOp.ref, writeOp.payload, { merge: true });
          } else {
            batch.set(writeOp.ref, writeOp.payload);
          }
        });

        try {
          await this.withTimeout(
            batch.commit(),
            WRITE_CHUNK_TIMEOUT_MS,
            `Timeout escribiendo chunk ${chunkLabel}`,
          );

          chunk.forEach((writeOp) => {
            const row = writeOp.row;
            commitRowsMap.set(row.rowNumber, {
              rowNumber: row.rowNumber,
              action: writeOp.action,
              status: 'success',
              reason: '',
              matchedUserId: row.matchedUserId || '',
              createdUserId:
                writeOp.action === 'create' ? writeOp.ref.id : '',
              email: row.normalizedPayload.email || '',
              number: row.normalizedPayload.number || '',
              tower: row.normalizedPayload.tower || '',
              name: row.normalizedPayload.name || '',
            });
          });

          this.logger.log(
            `[upsert.case][commit] Chunk ${chunkLabel} completado correctamente`,
          );
        } catch (error) {
          this.logger.error(
            `[upsert.case][commit] Error en chunk ${chunkLabel}: ${error.message}`,
            error.stack,
          );

          chunk.forEach((writeOp) => {
            const row = writeOp.row;
            commitRowsMap.set(row.rowNumber, {
              rowNumber: row.rowNumber,
              action: writeOp.action,
              status: 'error',
              reason: `Error al ${writeOp.action === 'create' ? 'crear' : 'actualizar'}: ${error.message || 'desconocido'}`,
              matchedUserId: row.matchedUserId || '',
              createdUserId: '',
              email: row.normalizedPayload.email || '',
              number: row.normalizedPayload.number || '',
              tower: row.normalizedPayload.tower || '',
              name: row.normalizedPayload.name || '',
            });
          });
        }
      }

      const orderedRows = Array.from(commitRowsMap.values()).sort(
        (a, b) => a.rowNumber - b.rowNumber,
      );

      const commitSummary = {
        createdCount: orderedRows.filter(
          (row) => row.action === 'create' && row.status === 'success',
        ).length,
        updatedCount: orderedRows.filter(
          (row) => row.action === 'update' && row.status === 'success',
        ).length,
        skippedCount: orderedRows.filter((row) => row.action === 'skip').length,
        errorCount: orderedRows.filter(
          (row) => row.action === 'error' || row.status === 'error',
        ).length,
      };

      await operationRef.set(
        {
          status: 'committed',
          committedAt: admin.firestore.FieldValue.serverTimestamp(),
          commitSummary,
        },
        { merge: true },
      );

      await this.firestore
        .collection(
          `clients/${input.clientId}/condominiums/${input.condominiumId}/auditTrail`,
        )
        .add({
          type: 'users_mass_upsert',
          operationId: input.operationId,
          dryRunSummary: operation.dryRunSummary,
          commitSummary,
          actorUid: input.actor.uid,
          actorEmail: input.actor.email,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          sourceIp: input.sourceIp || null,
          fileHash,
        });

      const worksheet = XLSX.utils.json_to_sheet(
        orderedRows.map((row) => ({
          rowNumber: row.rowNumber,
          action: row.action,
          status: row.status,
          reason: row.reason,
          matchedUserId: row.matchedUserId,
          createdUserId: row.createdUserId,
          email: row.email,
          number: row.number,
          tower: row.tower,
          name: row.name,
        })),
      );
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Resultados');

      const resultFileBase64 = XLSX.write(workbook, {
        type: 'base64',
        bookType: 'xlsx',
      });

      this.logger.log(
        `[upsert.case][commit] Finalizado operationId=${input.operationId} created=${commitSummary.createdCount} updated=${commitSummary.updatedCount} skipped=${commitSummary.skippedCount} errors=${commitSummary.errorCount} resultFileBase64Length=${resultFileBase64.length}`,
      );

      return {
        ok: true,
        operationId: input.operationId,
        summary: commitSummary,
        errors: orderedRows
          .filter((row) => row.action === 'error' || row.status === 'error')
          .map((row) => ({
            rowNumber: row.rowNumber,
            reason: row.reason,
          })),
        resultFile: {
          fileName: `users-mass-upsert-${input.operationId}.xlsx`,
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          base64: resultFileBase64,
        },
      };
    } catch (error) {
      this.logger.error(
        `[upsert.case][commit] Error operationId=${input.operationId} clientId=${input.clientId} condominiumId=${input.condominiumId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private validateClientAndCondominium(
    clientId: string,
    condominiumId: string,
  ): void {
    if (!clientId || !condominiumId) {
      throw new BadRequestException('clientId y condominiumId son obligatorios.');
    }
  }

  private validateFile(fileBuffer: Buffer, originalFileName?: string): void {
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      throw new UnprocessableEntityException('Archivo inválido o ausente.');
    }

    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('El archivo supera el tamaño máximo permitido (10MB).');
    }

    if (originalFileName) {
      const safeName = basename(originalFileName);
      const extension = extname(safeName).toLowerCase();
      if (!['.xlsx', '.xls'].includes(extension)) {
        throw new UnprocessableEntityException('El archivo debe ser .xlsx o .xls');
      }
    }
  }

  private parseExcelRows(fileBuffer: Buffer): NormalizedImportRow[] {
    try {
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new UnprocessableEntityException('El archivo no contiene hojas.');
      }

      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, {
        defval: '',
      });

      if (!rawRows.length) {
        throw new UnprocessableEntityException('El archivo está vacío.');
      }

      if (rawRows.length > MAX_ROWS) {
        throw new BadRequestException(
          `El archivo excede el límite de ${MAX_ROWS} filas.`,
        );
      }

      return rawRows.map((row, index) => mapAndNormalizeRow(row, index + 2));
    } catch (error) {
      this.logger.error(`Error al parsear Excel: ${error.message}`);
      if (
        error instanceof BadRequestException ||
        error instanceof UnprocessableEntityException
      ) {
        throw error;
      }
      throw new InternalServerErrorException('No fue posible procesar el archivo.');
    }
  }

  private getFileHash(fileBuffer: Buffer): string {
    return createHash('sha256').update(fileBuffer).digest('hex');
  }

  private getPlanHash(plan: UpsertPlan): string {
    const digestRows = plan.rows.map((row) => ({
      rowNumber: row.rowNumber,
      action: row.action,
      matchStrategy: row.matchStrategy,
      reasons: row.reasons,
      matchedUserId: row.matchedUserId || null,
      writePayload: row.writePayload || null,
    }));

    return createHash('sha256').update(JSON.stringify(digestRows)).digest('hex');
  }

  private async loadExistingUsers(
    clientId: string,
    condominiumId: string,
  ): Promise<ExistingUserRecord[]> {
    const usersSnapshot = await this.firestore
      .collection(`clients/${clientId}/condominiums/${condominiumId}/users`)
      .get();

    return usersSnapshot.docs.map((doc) => ({
      id: doc.id,
      raw: doc.data() || {},
    }));
  }
}

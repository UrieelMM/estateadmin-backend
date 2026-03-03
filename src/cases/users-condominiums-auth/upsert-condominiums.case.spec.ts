import { buildUpsertPlan, parseUpsertOptions } from './upsert-condominiums.case';

describe('buildUpsertPlan', () => {
  const existingUsers: any[] = [
    {
      id: 'u-1',
      raw: {
        email: 'ana@test.com',
        number: '101',
        tower: 'A',
        name: 'Ana',
        role: 'propietario',
      },
    },
    {
      id: 'u-2',
      raw: {
        email: 'duplicado@test.com',
        number: '200',
        tower: 'B',
        name: 'Pedro',
        role: 'propietario',
      },
    },
    {
      id: 'u-3',
      raw: {
        email: 'otro@test.com',
        number: '200',
        tower: 'C',
        name: 'Luis',
        role: 'inquilino',
      },
    },
  ];

  const baseOptions = parseUpsertOptions(undefined);

  it('calcula create/update/skip/error en modo upsert', () => {
    const rows: any[] = [
      {
        rowNumber: 2,
        name: 'Ana',
        lastName: 'P',
        email: 'ana@test.com',
        role: 'propietario',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '101',
        tower: 'A',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
      {
        rowNumber: 3,
        name: 'Nuevo',
        lastName: 'Usuario',
        email: 'nuevo@test.com',
        role: 'inquilino',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '999',
        tower: 'Z',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
      {
        rowNumber: 4,
        name: '',
        lastName: 'SinNombre',
        email: 'x@test.com',
        role: 'propietario',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '1000',
        tower: 'Z',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
    ];

    const plan = buildUpsertPlan({
      rows,
      existingUsers,
      mode: 'upsert',
      options: { ...baseOptions, allowRoleUpdate: true, allowEmailUpdate: true },
    });

    expect(plan.summary.totalRows).toBe(3);
    expect(plan.summary.willCreate).toBe(1);
    expect(plan.summary.willUpdate).toBe(1);
    expect(plan.summary.errorRows).toBe(1);
  });

  it('omite existentes en create_only', () => {
    const rows: any[] = [
      {
        rowNumber: 2,
        name: 'Ana',
        lastName: 'P',
        email: 'ana@test.com',
        role: 'propietario',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '101',
        tower: 'A',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
    ];

    const plan = buildUpsertPlan({
      rows,
      existingUsers,
      mode: 'create_only',
      options: baseOptions,
    });

    expect(plan.rows[0].action).toBe('skip');
    expect(plan.summary.willSkip).toBe(1);
  });

  it('omite no existentes en update_only', () => {
    const rows: any[] = [
      {
        rowNumber: 2,
        name: 'NoExiste',
        lastName: 'X',
        email: 'noexiste@test.com',
        role: 'propietario',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '500',
        tower: 'T1',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
    ];

    const plan = buildUpsertPlan({
      rows,
      existingUsers,
      mode: 'update_only',
      options: baseOptions,
    });

    expect(plan.rows[0].action).toBe('skip');
    expect(plan.rows[0].reasons[0]).toContain('update_only');
  });

  it('marca fila ambigua cuando number coincide con multiples usuarios en auto', () => {
    const rows: any[] = [
      {
        rowNumber: 2,
        name: 'Ambiguo',
        lastName: 'N',
        email: '',
        role: 'propietario',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '200',
        tower: '',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
    ];

    const plan = buildUpsertPlan({
      rows,
      existingUsers,
      mode: 'upsert',
      options: baseOptions,
    });

    expect(plan.rows[0].action).toBe('error');
    expect(plan.rows[0].reasons[0]).toContain('ambigua');
  });

  it('asigna propietario por defecto cuando role no viene', () => {
    const rows: any[] = [
      {
        rowNumber: 2,
        name: 'Condomino',
        lastName: 'Libre',
        email: 'condomino@test.com',
        role: '',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '700',
        tower: 'T1',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
    ];

    const plan = buildUpsertPlan({
      rows,
      existingUsers,
      mode: 'upsert',
      options: baseOptions,
    });

    expect(plan.rows[0].action).toBe('create');
    expect(plan.rows[0].writePayload?.role).toBe('propietario');
  });

  it('rechaza role fuera de la lista permitida', () => {
    const rows: any[] = [
      {
        rowNumber: 2,
        name: 'NoAdmin',
        lastName: 'X',
        email: 'noadmin@test.com',
        role: 'condomino',
        CP: '',
        address: '',
        country: '',
        city: '',
        state: '',
        number: '701',
        tower: 'T1',
        busisnessName: '',
        taxResidence: '',
        taxRegime: '',
        departament: '',
        photoURL: '',
        RFC: '',
        phone: '',
      },
    ];

    const plan = buildUpsertPlan({
      rows,
      existingUsers,
      mode: 'upsert',
      options: baseOptions,
    });

    expect(plan.rows[0].action).toBe('error');
    expect(plan.rows[0].reasons[0]).toContain('Valores permitidos: propietario, inquilino');
  });
});

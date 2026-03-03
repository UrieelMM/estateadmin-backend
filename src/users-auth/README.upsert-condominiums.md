# Upsert Masivo de Usuarios (Condominio)

## Endpoints
- `POST /users-auth/upsert-condominiums/dry-run`
- `POST /users-auth/upsert-condominiums/commit`

Ambos endpoints requieren `Authorization: Bearer <firebase_id_token>` con rol `admin` o `admin-assistant` y `clientId` del token igual al enviado.

## Request Dry-Run
`multipart/form-data`
- `file`: `.xlsx` o `.xls`
- `clientId`: string
- `condominiumId`: string
- `mode`: `upsert | update_only | create_only` (opcional, default `upsert`)
- `options`: JSON string opcional

Ejemplo `options`:
```json
{
  "skipEmptyUpdates": true,
  "matchBy": "auto",
  "allowRoleUpdate": false,
  "allowEmailUpdate": false,
  "allowNumberUpdate": true
}
```

Respuesta:
```json
{
  "ok": true,
  "operationId": "d6d6d066-41f0-4f8a-9bf2-8f7d70b9ca56",
  "expiresAt": "2026-03-03T20:00:00.000Z",
  "mode": "upsert",
  "options": {
    "skipEmptyUpdates": true,
    "matchBy": "auto",
    "allowRoleUpdate": false,
    "allowEmailUpdate": false,
    "allowNumberUpdate": true
  },
  "fileHash": "...sha256...",
  "summary": {
    "totalRows": 120,
    "validRows": 118,
    "errorRows": 2,
    "willCreate": 16,
    "willUpdate": 80,
    "willSkip": 22
  },
  "rows": [
    {
      "rowNumber": 2,
      "action": "update",
      "matchStrategy": "email",
      "reasons": [],
      "normalizedPayload": {
        "name": "Juan",
        "lastName": "Perez",
        "email": "juan@test.com",
        "role": "propietario",
        "number": "A-101",
        "tower": "Torre 1",
        "city": "Queretaro",
        "state": "Queretaro",
        "country": "Mexico"
      },
      "matchedUserId": "uid-123"
    }
  ]
}
```

## Request Commit
`multipart/form-data`
- `file`: mismo archivo del dry-run
- `clientId`: string
- `condominiumId`: string
- `operationId`: string

Respuesta:
```json
{
  "ok": true,
  "operationId": "d6d6d066-41f0-4f8a-9bf2-8f7d70b9ca56",
  "summary": {
    "createdCount": 16,
    "updatedCount": 80,
    "skippedCount": 22,
    "errorCount": 2
  },
  "errors": [
    {
      "rowNumber": 11,
      "reason": "Role inválido"
    }
  ],
  "resultFile": {
    "fileName": "users-mass-upsert-d6d6d066-41f0-4f8a-9bf2-8f7d70b9ca56.xlsx",
    "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "base64": "..."
  }
}
```

## Columnas esperadas del Excel
`name, lastName, email, role, CP, address, country, city, state, number, tower, busisnessName, taxResidence, taxRegime, departament, photoURL, RFC, phone`

Valores permitidos para `role`:
- `propietario`
- `inquilino`

Si `role` no viene, se usa `propietario` por defecto.

Alias aceptado:
- `businessName` -> se mapea internamente a `busisnessName`.

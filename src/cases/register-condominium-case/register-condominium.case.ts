import * as admin from 'firebase-admin';
import { BadRequestException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { BillingFrequency, CondominiumStatus } from 'src/dtos/register-client.dto';

/**
 * Asegura que los usuarios con rol `admin` del cliente tengan acceso a todos
 * los condominios del cliente. Esto se aplica:
 *  - Al crear un condominio nuevo para un cliente existente (auto).
 *  - Manualmente desde el panel del super admin (sync-admin-condominiums)
 *    para regularizar clientes que se crearon antes de este fix.
 *
 * Acciones:
 *  1. Agrega `targetCondominiumUid` al array `condominiumUids` de cada doc
 *     admin que viva dentro de cualquier subcolección users de cualquier
 *     condominio del cliente.
 *  2. Replica cada doc admin dentro de la subcolección users del
 *     `targetCondominiumUid` para que las consultas que dependen del
 *     currentCondominiumId (fetchAdminUsers, fetchUserDetails, etc.) sigan
 *     funcionando al cambiar al nuevo condominio.
 *
 * Idempotente: usa arrayUnion + set con merge. Re-ejecutar produce el
 * mismo estado.
 */
export const propagateAdminAccessToCondominium = async (params: {
  clientId: string;
  targetCondominiumUid: string;
}): Promise<{ adminUsersUpdated: number; condominiumsScanned: number }> => {
  const { clientId, targetCondominiumUid } = params;
  const firestoreInstance = admin.firestore();

  const condominiumsSnap = await firestoreInstance
    .collection('clients')
    .doc(clientId)
    .collection('condominiums')
    .get();

  const adminUserDocs: Array<{
    userId: string;
    data: FirebaseFirestore.DocumentData;
  }> = [];

  let condominiumsScanned = 0;
  for (const condDoc of condominiumsSnap.docs) {
    condominiumsScanned += 1;
    if (condDoc.id === targetCondominiumUid) continue;

    const adminsQuery = await firestoreInstance
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condDoc.id)
      .collection('users')
      .where('role', '==', 'admin')
      .get();

    const propagateBatch = firestoreInstance.batch();
    let hasOps = false;
    for (const userDoc of adminsQuery.docs) {
      propagateBatch.update(userDoc.ref, {
        condominiumUids: admin.firestore.FieldValue.arrayUnion(
          targetCondominiumUid,
        ),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      hasOps = true;

      if (!adminUserDocs.some((u) => u.userId === userDoc.id)) {
        adminUserDocs.push({ userId: userDoc.id, data: userDoc.data() });
      }
    }
    if (hasOps) {
      await propagateBatch.commit();
    }
  }

  if (adminUserDocs.length === 0) {
    return { adminUsersUpdated: 0, condominiumsScanned };
  }

  const replicateBatch = firestoreInstance.batch();
  const newCondominiumUsersRef = firestoreInstance
    .collection('clients')
    .doc(clientId)
    .collection('condominiums')
    .doc(targetCondominiumUid)
    .collection('users');

  for (const { userId, data } of adminUserDocs) {
    const existingUids: string[] = Array.isArray(data.condominiumUids)
      ? data.condominiumUids
      : [];
    const mergedUids = Array.from(
      new Set([...existingUids, targetCondominiumUid]),
    );
    replicateBatch.set(
      newCondominiumUsersRef.doc(userId),
      {
        ...data,
        condominiumUids: mergedUids,
        propagatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  await replicateBatch.commit();

  return {
    adminUsersUpdated: adminUserDocs.length,
    condominiumsScanned,
  };
};

/**
 * Sincroniza el acceso de los administradores a TODOS los condominios del
 * cliente. Útil para regularizar clientes creados antes del fix de
 * propagación automática.
 */
export const syncAdminAccessAcrossClient = async (params: {
  clientId: string;
}): Promise<{
  condominiumsScanned: number;
  adminUsersUpdated: number;
  perCondominium: Array<{
    condominiumId: string;
    adminUsersUpdated: number;
  }>;
}> => {
  const firestoreInstance = admin.firestore();
  const condominiumsSnap = await firestoreInstance
    .collection('clients')
    .doc(params.clientId)
    .collection('condominiums')
    .get();

  const allCondominiumIds = condominiumsSnap.docs.map((d) => d.id);
  const perCondominium: Array<{
    condominiumId: string;
    adminUsersUpdated: number;
  }> = [];
  let totalUpdated = 0;

  for (const condId of allCondominiumIds) {
    const result = await propagateAdminAccessToCondominium({
      clientId: params.clientId,
      targetCondominiumUid: condId,
    });
    perCondominium.push({
      condominiumId: condId,
      adminUsersUpdated: result.adminUsersUpdated,
    });
    totalUpdated += result.adminUsersUpdated;
  }

  return {
    condominiumsScanned: allCondominiumIds.length,
    adminUsersUpdated: totalUpdated,
    perCondominium,
  };
};

export const RegisterCondominiumCase = async (condominiumData: {
  name: string;
  address: string;
  condominiumManager?: string;
  clientId: string;
  plan: string;
  pricing?: number | string;
  pricingWithoutTax?: number | string;
  pricingWithoutIVA?: number | string;
  pricingWithoutIva?: number | string;
  billingFrequency?: BillingFrequency;
  condominiumLimit: number;
  status: CondominiumStatus;
  proFunctions?: string[];
  currency?: string;
  language?: string;
  hasMaintenanceApp?: boolean;
  maintenanceAppContractedAt?: string;
  coupon?: string;
}) => {
  try {
    const {
      name,
      address,
      condominiumManager,
      clientId,
      plan,
      pricing,
      pricingWithoutTax,
      pricingWithoutIVA,
      pricingWithoutIva,
      billingFrequency = BillingFrequency.Monthly,
      condominiumLimit,
      status = CondominiumStatus.Pending,
      proFunctions = [],
      currency = 'MXN',
      language = 'es-MX',
      hasMaintenanceApp = false,
      maintenanceAppContractedAt,
      coupon,
    } = condominiumData;

    const normalizeCoupon = (value?: string | null): string | null => {
      const normalized = String(value || '').trim().toUpperCase();
      return normalized || null;
    };
    const normalizedCoupon = normalizeCoupon(coupon);
    if (normalizedCoupon && normalizedCoupon.length < 8) {
      throw new BadRequestException(
        'El cupón debe tener al menos 8 caracteres.',
      );
    }
    const normalizePricingValue = (value: unknown): number | string | null => {
      if (value === null || value === undefined) {
        return null;
      }
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
          return null;
        }
        const numeric = Number(trimmed.replace(/,/g, ''));
        return Number.isFinite(numeric) ? numeric : trimmed;
      }
      return null;
    };
    const roundToTwo = (value: number): number =>
      Math.round((value + Number.EPSILON) * 100) / 100;
    const extractNumericPricing = (value: number | string | null): number | null => {
      if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
      }
      if (typeof value === 'string') {
        const numeric = Number(value.replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
        return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      }
      return null;
    };
    const resolvedPricing = normalizePricingValue(pricing);
    const explicitPricingWithoutTax =
      normalizePricingValue(pricingWithoutTax) ??
      normalizePricingValue(pricingWithoutIVA) ??
      normalizePricingValue(pricingWithoutIva);
    const pricingNumeric = extractNumericPricing(resolvedPricing);
    const fallbackPricingWithoutTax =
      pricingNumeric && pricingNumeric > 0
        ? roundToTwo(pricingNumeric / 1.16)
        : null;
    const resolvedPricingWithoutTax =
      explicitPricingWithoutTax ??
      fallbackPricingWithoutTax ??
      resolvedPricing;
    const resolvedHasMaintenanceApp = Boolean(hasMaintenanceApp);
    const parsedMaintenanceContractDate = maintenanceAppContractedAt
      ? new Date(maintenanceAppContractedAt)
      : null;
    const hasValidMaintenanceContractDate = Boolean(
      parsedMaintenanceContractDate &&
        !Number.isNaN(parsedMaintenanceContractDate.getTime()),
    );
    const resolvedMaintenanceAppContractedAtForWrite = (() => {
      if (!resolvedHasMaintenanceApp) return null;

      if (hasValidMaintenanceContractDate && parsedMaintenanceContractDate) {
        return admin.firestore.Timestamp.fromDate(parsedMaintenanceContractDate);
      }

      return admin.firestore.FieldValue.serverTimestamp();
    })();
    const resolvedMaintenanceAppContractedAtForResponse =
      resolvedHasMaintenanceApp
        ? hasValidMaintenanceContractDate && parsedMaintenanceContractDate
          ? parsedMaintenanceContractDate.toISOString()
          : new Date().toISOString()
        : null;
    const uid = uuidv4(); // Generamos el UID único

    // Verificar que el cliente existe
    const clientDoc = await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .get();

    if (!clientDoc.exists) {
      throw new Error('Cliente no encontrado');
    }

    // Crear el nuevo condominio
    await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(uid)
      .set({
        uid,
        name,
        address,
        condominiumManager: String(condominiumManager || '').trim() || null,
        plan,
        pricing: resolvedPricing,
        pricingWithoutTax: resolvedPricingWithoutTax,
        billingFrequency,
        condominiumLimit,
        status,
        proFunctions,
        hasMaintenanceApp: resolvedHasMaintenanceApp,
        maintenanceAppContractedAt: resolvedMaintenanceAppContractedAtForWrite,
        currency,
        language,
        // createdAt y createdDate se mantienen ambos por consistencia con el
        // documento generado al registrar el primer condominio en register-client.case.ts.
        // El frontend lee preferentemente createdDate.
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdDate: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(normalizedCoupon
          ? {
              coupon: normalizedCoupon,
              couponStatus: 'active',
              couponCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
              initialSetupPaymentBypassed: false,
            }
          : {}),
      });

    // Actualizar el perfil del cliente con el UID del nuevo condominio
    await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .update({
        condominiumUids: admin.firestore.FieldValue.arrayUnion(uid),
      });

    // === Propagar el nuevo condominio a los administradores del cliente ===
    // El usuario `admin` del cliente vive dentro de la subcolección users
    // del condominio original (creado al registrarse el cliente). Para que
    // el ComboBox del navbar y el resto del dashboard reconozcan el nuevo
    // condominio sin re-login, propagamos el `uid` a sus `condominiumUids`
    // y replicamos su doc en la subcolección users del nuevo condominio.
    // Best-effort: si falla, se loguea pero NO se rompe la creación del
    // condominio. El super admin puede re-disparar manualmente usando el
    // endpoint sync-admin-condominiums.
    try {
      await propagateAdminAccessToCondominium({
        clientId,
        targetCondominiumUid: uid,
      });
    } catch (propagationError: any) {
      console.error(
        `[register-condominium] Falló la propagación del condominio ${uid} a los administradores del cliente ${clientId}:`,
        propagationError?.message || propagationError,
      );
    }

    return {
      id: uid,
      name,
      address,
      condominiumManager: String(condominiumManager || '').trim() || null,
      plan,
      pricing: resolvedPricing,
      pricingWithoutTax: resolvedPricingWithoutTax,
      billingFrequency,
      condominiumLimit,
      status,
      proFunctions,
      hasMaintenanceApp: resolvedHasMaintenanceApp,
      maintenanceAppContractedAt: resolvedMaintenanceAppContractedAtForResponse,
      currency,
      language,
      coupon: normalizedCoupon,
      message: 'Condominio creado exitosamente',
    };
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new Error(`Error al crear el condominio: ${error.message}`);
  }
};

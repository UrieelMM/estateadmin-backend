import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { BillingFrequency, CondominiumStatus } from 'src/dtos/register-client.dto';

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
    } = condominiumData;
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Actualizar el perfil del cliente con el UID del nuevo condominio
    await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .update({
        condominiumUids: admin.firestore.FieldValue.arrayUnion(uid),
      });

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
      message: 'Condominio creado exitosamente',
    };
  } catch (error) {
    throw new Error(`Error al crear el condominio: ${error.message}`);
  }
};

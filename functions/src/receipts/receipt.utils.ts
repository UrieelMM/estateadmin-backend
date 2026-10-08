import * as admin from 'firebase-admin';
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

interface EnsureReceiptInput {
  clientId: string;
  condominiumId: string;
  paymentGroupId: string;
  source?: string;
}

interface PersistReceiptInput extends EnsureReceiptInput {
  pdfBytes: Uint8Array;
}

interface ConsolidatedPaymentDoc {
  id: string;
  ref: admin.firestore.DocumentReference;
  data: Record<string, any>;
}

export interface EnsureReceiptResult {
  receiptUrl: string;
  storagePath: string;
  generated: boolean;
  updatedConsolidated: number;
  updatedPayments: number;
}

const RECEIPT_BUCKET = 'administracioncondominio-93419.appspot.com';

const toCurrency = (value: any): string => {
  const num = (Number(value) || 0) / 100;
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
  }).format(num);
};

const toDateString = (value: any): string => {
  if (!value) return 'No especificada';
  try {
    const dateObj = value.toDate ? value.toDate() : new Date(value);
    if (isNaN(dateObj.getTime())) return 'No especificada';
    return dateObj.toLocaleDateString('es-MX');
  } catch {
    return 'No especificada';
  }
};

const getPaymentsArrayFromConsolidated = (data: Record<string, any>) => {
  if (Array.isArray(data.payments) && data.payments.length > 0) {
    return data.payments;
  }
  return [data];
};

const getReceiptPath = (params: EnsureReceiptInput): string => {
  const safeGroupId = String(params.paymentGroupId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `clients/${params.clientId}/condominiums/${params.condominiumId}/receipts/${safeGroupId}.pdf`;
};

const getPublicStorageUrl = (bucketName: string, filePath: string): string =>
  `https://storage.googleapis.com/${bucketName}/${filePath}`;

const getConsolidatedDocsByGroup = async (
  params: EnsureReceiptInput,
): Promise<ConsolidatedPaymentDoc[]> => {
  const paymentsToSendEmailRef = admin
    .firestore()
    .collection('clients')
    .doc(params.clientId)
    .collection('condominiums')
    .doc(params.condominiumId)
    .collection('paymentsToSendEmail');

  const byGroupSnapshot = await paymentsToSendEmailRef
    .where('paymentGroupId', '==', params.paymentGroupId)
    .get();

  if (!byGroupSnapshot.empty) {
    return byGroupSnapshot.docs.map((doc) => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data() || {},
    }));
  }

  const byIdDoc = await paymentsToSendEmailRef.doc(params.paymentGroupId).get();
  if (byIdDoc.exists) {
    return [
      {
        id: byIdDoc.id,
        ref: byIdDoc.ref,
        data: byIdDoc.data() || {},
      },
    ];
  }

  return [];
};

const generateBasicReceiptPdf = async (params: {
  clientData: Record<string, any>;
  condominiumData: Record<string, any>;
  userData: Record<string, any>;
  consolidatedPayment: Record<string, any>;
  paymentGroupId: string;
}): Promise<Uint8Array> => {
  const { clientData, condominiumData, userData, consolidatedPayment, paymentGroupId } = params;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const brandColor = rgb(0.39, 0.4, 0.95);

  page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: brandColor });
  page.drawText('Recibo de pago', {
    x: 24,
    y: height - 52,
    size: 26,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  const managerName = String(condominiumData.condominiumManager || 'Administración').trim();
  page.drawText(`Administrador: ${managerName}`, {
    x: 24,
    y: height - 128,
    size: 12,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });

  page.drawText(`Residente: ${userData.name || 'Sin nombre'}`, {
    x: 24,
    y: height - 148,
    size: 12,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });

  page.drawText(`Folio: ${consolidatedPayment.folio || paymentGroupId}`, {
    x: 24,
    y: height - 168,
    size: 12,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });

  const receiptPaymentDate = consolidatedPayment.paymentDate ||
    getPaymentsArrayFromConsolidated(consolidatedPayment)[0]?.paymentDate ||
    consolidatedPayment.dateRegistered;
  page.drawText(`Fecha de pago: ${toDateString(receiptPaymentDate)}`, {
    x: 24,
    y: height - 188,
    size: 12,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });

  const logoUrl = String(clientData.logoReports || clientData.logoUrl || '').trim();
  if (logoUrl) {
    try {
      const response = await fetch(logoUrl);
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        let logo;
        try { logo = await pdfDoc.embedPng(bytes); }
        catch { logo = await pdfDoc.embedJpg(bytes); }
        const scale = Math.min(260 / logo.width, 78 / logo.height);
        page.drawImage(logo, {
          x: width - logo.width * scale - 20,
          y: height - 84 + (78 - logo.height * scale) / 2,
          width: logo.width * scale,
          height: logo.height * scale,
        });
      }
    } catch (error) {
      console.warn('No se pudo incluir el logo en el recibo de respaldo', error);
    }
  }

  const paymentsArray = getPaymentsArrayFromConsolidated(consolidatedPayment);

  let totalPaid = 0;
  let totalCharges = 0;

  paymentsArray.forEach((payment) => {
    totalPaid += Number(payment.amountPaid || 0);
    totalCharges += Number(payment.chargeValue || 0);
  });

  if (consolidatedPayment.chargeValue) {
    totalCharges = Number(consolidatedPayment.chargeValue || 0);
  }

  const totalBalance = totalPaid - totalCharges;

  page.drawText(`Cargos: ${toCurrency(totalCharges)}`, {
    x: 24,
    y: height - 230,
    size: 12,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  page.drawText(`Total pagado: ${toCurrency(totalPaid)}`, {
    x: 24,
    y: height - 250,
    size: 12,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  page.drawText(`Saldo: ${toCurrency(totalBalance)}`, {
    x: 24,
    y: height - 270,
    size: 12,
    font: fontBold,
    color: rgb(0, 0, 0),
  });

  let y = height - 310;
  page.drawText('Detalle:', {
    x: 24,
    y,
    size: 13,
    font: fontBold,
    color: rgb(0, 0, 0),
  });

  y -= 20;
  for (const payment of paymentsArray) {
    const concept = payment.concept || 'Sin concepto';
    const line = `${concept} - ${toCurrency(payment.amountPaid || 0)}`;
    page.drawText(line.substring(0, 100), {
      x: 24,
      y,
      size: 11,
      font: fontRegular,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= 16;
    if (y < 80) {
      break;
    }
  }

  page.drawText('Documento generado automáticamente por EstateAdmin', {
    x: 24,
    y: 40,
    size: 10,
    font: fontRegular,
    color: rgb(0.45, 0.45, 0.45),
  });

  return await pdfDoc.save();
};

export const persistReceiptPdfForPaymentGroup = async (
  params: PersistReceiptInput,
): Promise<EnsureReceiptResult> => {
  const consolidatedDocs = await getConsolidatedDocsByGroup(params);
  if (consolidatedDocs.length === 0) {
    throw new Error(
      `No se encontraron documentos consolidados para paymentGroupId=${params.paymentGroupId}`,
    );
  }

  const storagePath = getReceiptPath(params);
  const bucket = admin.storage().bucket(RECEIPT_BUCKET);
  const file = bucket.file(storagePath);

  await file.save(Buffer.from(params.pdfBytes), {
    contentType: 'application/pdf',
    metadata: {
      cacheControl: 'public,max-age=31536000',
      metadata: {
        clientId: params.clientId,
        condominiumId: params.condominiumId,
        paymentGroupId: params.paymentGroupId,
        source: params.source || 'unknown',
      },
    },
  });

  try {
    await file.makePublic();
  } catch (error) {
    console.log(
      `[receipt.utils] No se pudo hacer público ${storagePath}, se usará URL pública directa`,
      error,
    );
  }

  const receiptUrl = getPublicStorageUrl(bucket.name, storagePath);

  const now = admin.firestore.FieldValue.serverTimestamp();

  let updatedConsolidated = 0;
  for (const consolidatedDoc of consolidatedDocs) {
    await consolidatedDoc.ref.set(
      {
        receiptUrl,
        receiptGeneratedAt: now,
        receiptSource: params.source || 'unknown',
      },
      { merge: true },
    );
    updatedConsolidated += 1;
  }

  const paymentDocRefs = new Map<string, admin.firestore.DocumentReference>();

  consolidatedDocs.forEach((consolidatedDoc) => {
    const paymentsArray = getPaymentsArrayFromConsolidated(consolidatedDoc.data);
    paymentsArray.forEach((payment) => {
      const userId = String(payment.userId || consolidatedDoc.data.userId || '');
      const chargeUID = String(payment.chargeUID || '');
      const paymentId = String(payment.paymentId || '');

      if (!userId || !chargeUID || !paymentId) {
        return;
      }

      const ref = admin
        .firestore()
        .collection('clients')
        .doc(params.clientId)
        .collection('condominiums')
        .doc(params.condominiumId)
        .collection('users')
        .doc(userId)
        .collection('charges')
        .doc(chargeUID)
        .collection('payments')
        .doc(paymentId);

      paymentDocRefs.set(ref.path, ref);
    });
  });

  let updatedPayments = 0;
  const refs = Array.from(paymentDocRefs.values());
  const chunkSize = 450;

  for (let i = 0; i < refs.length; i += chunkSize) {
    const chunk = refs.slice(i, i + chunkSize);
    const batch = admin.firestore().batch();

    chunk.forEach((ref) => {
      batch.set(
        ref,
        {
          receiptUrl,
          receiptGeneratedAt: now,
        },
        { merge: true },
      );
    });

    await batch.commit();
    updatedPayments += chunk.length;
  }

  return {
    receiptUrl,
    storagePath,
    generated: true,
    updatedConsolidated,
    updatedPayments,
  };
};

const resolveUserDataForConsolidated = async (params: {
  clientId: string;
  condominiumId: string;
  consolidatedPayment: Record<string, any>;
}): Promise<Record<string, any>> => {
  const { clientId, condominiumId, consolidatedPayment } = params;

  const userId = String(consolidatedPayment.userId || '');
  if (userId) {
    const userDoc = await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('users')
      .doc(userId)
      .get();

    if (userDoc.exists) {
      return userDoc.data() || {};
    }
  }

  const email = String(consolidatedPayment.email || '').trim().toLowerCase();
  if (email) {
    const userSnap = await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!userSnap.empty) {
      return userSnap.docs[0].data() || {};
    }
  }

  return {
    name: 'Residente',
    email,
  };
};

export const ensureReceiptUrlForPaymentGroup = async (
  params: EnsureReceiptInput,
): Promise<EnsureReceiptResult> => {
  const consolidatedDocs = await getConsolidatedDocsByGroup(params);
  if (consolidatedDocs.length === 0) {
    throw new Error(
      `No se encontró pago consolidado para paymentGroupId=${params.paymentGroupId}`,
    );
  }

  const consolidatedPayment = consolidatedDocs[0].data;
  const existingReceiptUrl = String(consolidatedPayment.receiptUrl || '').trim();
  const storagePath = getReceiptPath(params);

  if (existingReceiptUrl) {
    return {
      receiptUrl: existingReceiptUrl,
      storagePath,
      generated: false,
      updatedConsolidated: 0,
      updatedPayments: 0,
    };
  }

  const clientDoc = await admin
    .firestore()
    .collection('clients')
    .doc(params.clientId)
    .get();

  const clientData = clientDoc.data() || {};
  const condominiumDoc = await admin.firestore()
    .doc(`clients/${params.clientId}/condominiums/${params.condominiumId}`).get();
  const userData = await resolveUserDataForConsolidated({
    clientId: params.clientId,
    condominiumId: params.condominiumId,
    consolidatedPayment,
  });

  const pdfBytes = await generateBasicReceiptPdf({
    clientData,
    condominiumData: condominiumDoc.data() || {},
    userData,
    consolidatedPayment,
    paymentGroupId: params.paymentGroupId,
  });

  return await persistReceiptPdfForPaymentGroup({
    ...params,
    pdfBytes,
    source: params.source || 'fallback_generation',
  });
};

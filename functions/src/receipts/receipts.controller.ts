import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import {
  ensureReceiptUrlForPaymentGroup,
} from './receipt.utils';
const cors = require('cors');
const { MailerSend, EmailParams, Recipient, Sender } = require('mailersend');
const JSZip = require('jszip');

// Configuración simple de CORS
const corsHandler = cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

const ALLOWED_ROLES = new Set(['admin', 'admin-assistant', 'super-provider-admin']);
const MAX_FILES_PER_EMAIL = Number(process.env.RECEIPTS_MAX_FILES_PER_EMAIL || 100);
const MAX_RAW_BYTES_PER_CHUNK = Number(
  process.env.RECEIPTS_MAX_RAW_BYTES_PER_CHUNK || 14 * 1024 * 1024,
);
const ZIP_SIGNED_URL_TTL_HOURS = Number(process.env.RECEIPTS_ZIP_LINK_TTL_HOURS || 48);
const RECEIPTS_ZIP_RETENTION_HOURS = Number(
  process.env.RECEIPTS_ZIP_RETENTION_HOURS || 48,
);
const RECEIPTS_CLEANUP_SCAN_LIMIT = Number(
  process.env.RECEIPTS_CLEANUP_SCAN_LIMIT || 10000,
);
const RECEIPTS_CLEANUP_DELETE_LIMIT = Number(
  process.env.RECEIPTS_CLEANUP_DELETE_LIMIT || 5000,
);

type AuthContext = {
  uid: string;
  email: string;
  role: string;
  clientId: string;
};

type RecipientContext = {
  email: string;
  name: string;
  userId?: string;
};

const toHttpError = (statusCode: number, message: string): Error & { statusCode: number } => {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
};

const parseBoolean = (value: any): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const parsed = value.trim().toLowerCase();
    return parsed === 'true' || parsed === '1' || parsed === 'yes';
  }
  return false;
};

const isReversedPaymentRecord = (payment: any): boolean =>
  payment?.isReversed === true ||
  String(payment?.reversalStatus || '').trim().toLowerCase() === 'reversed' ||
  !!String(payment?.reversalId || '').trim();

const sanitizeFileNamePart = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-.]/g, '')
    .slice(0, 60) || 'archivo';

const formatLocalDate = (): string => {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

const uploadZipAndGetSignedUrl = async (params: {
  clientId: string;
  condominiumId: string;
  yearMonth: string;
  docType: string;
  part: number;
  totalParts: number;
  zipBuffer: Buffer;
}): Promise<{ storagePath: string; signedUrl: string; sizeBytes: number }> => {
  const bucket = admin.storage().bucket();
  const randomId = admin.firestore().collection('_').doc().id;
  const fileName = `documentos-${params.docType}-${params.yearMonth}-parte-${String(
    params.part,
  ).padStart(2, '0')}-de-${String(params.totalParts).padStart(2, '0')}-${randomId}.zip`;
  const storagePath = `receipts-deliveries/${params.clientId}/${params.condominiumId}/${formatLocalDate()}/${fileName}`;
  const file = bucket.file(storagePath);

  await file.save(params.zipBuffer, {
    resumable: false,
    contentType: 'application/zip',
    metadata: {
      cacheControl: 'private, max-age=0, no-cache',
    },
  });

  const expiresAt = Date.now() + ZIP_SIGNED_URL_TTL_HOURS * 60 * 60 * 1000;
  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: expiresAt,
  });

  return {
    storagePath,
    signedUrl,
    sizeBytes: params.zipBuffer.length,
  };
};

const buildEmailHtml = (params: {
  recipientName: string;
  totalFiles: number;
  month: string;
  year: string;
  docType: string;
  bodyExtraHtml: string;
}): string => `
  <html>
    <head>
      <style>
        :root { font-family: 'Open Sans', sans-serif; }
        .footer-link { color: #6366F1 !important; text-decoration: none; }
      </style>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
    </head>
    <body style="background-color: #f6f6f6;">
      <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
        <tr>
          <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
            <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
          </td>
        </tr>
        <tr>
          <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Documentos de Pago Disponibles</h1>
          </td>
        </tr>
        <tr>
          <td style="padding: 20px 0; text-align: center;">
            <p style="font-size: 16px;">Hola ${params.recipientName}, se procesaron ${params.totalFiles} documentos de pago del mes ${params.month} de ${params.year}.</p>
            <p style="font-size: 14px;">Tipo de documento: ${params.docType}.</p>
            ${params.bodyExtraHtml}
          </td>
        </tr>
      </table>
    </body>
  </html>
`;

const verifyAuthAndTenant = async (
  req: any,
  clientId: string,
): Promise<AuthContext> => {
  const authHeader = String(req.headers?.authorization || '');
  if (!authHeader.startsWith('Bearer ')) {
    throw toHttpError(401, 'Authorization Bearer token requerido.');
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw toHttpError(401, 'Token vacío.');
  }

  let decodedToken: admin.auth.DecodedIdToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(token, true);
  } catch {
    throw toHttpError(401, 'Token inválido o expirado.');
  }

  const role = String(decodedToken.role || '').trim();
  if (!ALLOWED_ROLES.has(role)) {
    throw toHttpError(403, 'Rol no autorizado para esta operación.');
  }

  const tokenClientId = String(decodedToken.clientId || '').trim();
  if (role !== 'super-provider-admin' && tokenClientId !== clientId) {
    throw toHttpError(403, 'El clientId del token no coincide con el solicitado.');
  }

  return {
    uid: decodedToken.uid,
    email: decodedToken.email || '',
    role,
    clientId: tokenClientId,
  };
};

const resolveRecipient = async (params: {
  clientId: string;
  condominiumId: string;
  targetUserId?: string;
  email?: string;
}): Promise<RecipientContext> => {
  const usersRef = admin
    .firestore()
    .collection('clients')
    .doc(params.clientId)
    .collection('condominiums')
    .doc(params.condominiumId)
    .collection('users');

  const targetUserId = String(params.targetUserId || '').trim();
  const emailParam = String(params.email || '').trim().toLowerCase();

  if (targetUserId) {
    const userDoc = await usersRef.doc(targetUserId).get();
    if (!userDoc.exists) {
      throw toHttpError(404, 'No se encontró el usuario destino.');
    }

    const userData = userDoc.data() || {};
    const recipientEmail = String(userData.email || '').trim().toLowerCase();
    if (!recipientEmail || !recipientEmail.includes('@')) {
      throw toHttpError(400, 'El usuario destino no tiene un email válido.');
    }

    return {
      email: recipientEmail,
      name: String(userData.name || 'Usuario'),
      userId: userDoc.id,
    };
  }

  if (emailParam) {
    const userSnapshot = await usersRef.where('email', '==', emailParam).limit(1).get();
    if (!userSnapshot.empty) {
      const userDoc = userSnapshot.docs[0];
      const userData = userDoc.data() || {};
      return {
        email: emailParam,
        name: String(userData.name || 'Usuario'),
        userId: userDoc.id,
      };
    }

    return {
      email: emailParam,
      name: 'Usuario',
    };
  }

  throw toHttpError(400, 'Debes enviar targetUserId o email para el destinatario.');
};

const setCorsHeaders = (res: any) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

export const sendReceiptsByEmail = onRequest(
  {
    cors: true,
    region: 'us-central1',
    invoker: 'public',
    maxInstances: 10,
  },
  async (req: any, res: any) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    return corsHandler(req, res, async () => {
      try {
        const params = req.method === 'POST' ? req.body : req.query;

        const year = String(params.year || '').trim();
        const month = String(params.month || '').trim();
        const clientId = String(params.clientId || '').trim();
        const condominiumId = String(params.condominiumId || '').trim();
        const docType = String(params.docType || '').trim().toLowerCase();
        const email = String(params.email || '').trim();
        const targetUserId = String(params.targetUserId || '').trim();

        if (!year || !month || !clientId || !condominiumId || !docType) {
          throw toHttpError(
            400,
            'Faltan parámetros: year, month, clientId, condominiumId y docType.',
          );
        }

        if (docType !== 'recibos' && docType !== 'comprobantes') {
          throw toHttpError(400, "docType inválido. Usa 'recibos' o 'comprobantes'.");
        }

        await verifyAuthAndTenant(req, clientId);

        const recipient = await resolveRecipient({
          clientId,
          condominiumId,
          targetUserId,
          email,
        });

        const monthString = month.padStart(2, '0');
        const yearMonth = `${year}-${monthString}`;

        console.log(
          `[sendReceiptsByEmail] Buscando documentos yearMonth=${yearMonth}, condominiumId=${condominiumId}, clientId=${clientId}, docType=${docType}`,
        );
        console.log(
          `[sendReceiptsByEmail] Destinatario final email=${recipient.email}, userId=${recipient.userId || 'N/A'}`,
        );

        let snapshot: admin.firestore.QuerySnapshot;
        if (docType === 'recibos') {
          snapshot = await admin
            .firestore()
            .collectionGroup('paymentsToSendEmail')
            .where('yearMonth', '==', yearMonth)
            .where('condominiumId', '==', condominiumId)
            .where('clientId', '==', clientId)
            .get();
        } else {
          snapshot = await admin
            .firestore()
            .collectionGroup('payments')
            .where('yearMonth', '==', yearMonth)
            .where('condominiumId', '==', condominiumId)
            .where('clientId', '==', clientId)
            .get();
        }

        console.log(
          `[sendReceiptsByEmail] Se encontraron ${snapshot.size} documentos para docType=${docType}`,
        );

        if (snapshot.empty) {
          throw toHttpError(404, 'No se encontraron documentos para la fecha indicada.');
        }

        const storageBaseUrl =
          'https://storage.googleapis.com/administracioncondominio-93419.appspot.com/';

        let archivosAgregados = 0;
        const processedPaymentGroupIds = new Set<string>();
        const processedFilePaths = new Set<string>();
        const zipPayloads: Array<{
          zipBuffer: Buffer;
          fileCount: number;
          part: number;
        }> = [];

        let currentZip = new JSZip();
        let currentZipFileCount = 0;
        let currentZipRawBytes = 0;

        const flushZipChunk = async () => {
          if (currentZipFileCount === 0) {
            return;
          }

          const zipBuffer = await currentZip.generateAsync({ type: 'nodebuffer' });
          zipPayloads.push({
            zipBuffer,
            fileCount: currentZipFileCount,
            part: zipPayloads.length + 1,
          });

          currentZip = new JSZip();
          currentZipFileCount = 0;
          currentZipRawBytes = 0;
        };

        for (const doc of snapshot.docs) {
          const data = doc.data() || {};
          if (isReversedPaymentRecord(data)) {
            continue;
          }
          console.log(`[sendReceiptsByEmail] Procesando doc ${doc.id}, path=${doc.ref.path}`);

          let userName = 'usuario';
          const safeUserName = sanitizeFileNamePart(userName);
          const safeNumber = sanitizeFileNamePart(String(data.numberCondominium || 'sin-numero'));
          const userId = String(data.userId || '').trim();

          if (userId) {
            try {
              const userPath = `clients/${clientId}/condominiums/${condominiumId}/users/${userId}`;
              const userDoc = await admin.firestore().doc(userPath).get();
              if (userDoc.exists) {
                const userData = userDoc.data() || {};
                userName = String(userData.name || userData.displayName || 'usuario');
              }
            } catch (error) {
              console.error('[sendReceiptsByEmail] Error al obtener usuario:', error);
            }
          }
          const safeResolvedUserName = sanitizeFileNamePart(userName || safeUserName);

          let fileUrl: string | undefined;
          let fileName: string | undefined;

          if (docType === 'recibos') {
            const paymentGroupId = String(data.paymentGroupId || doc.id).trim();
            if (processedPaymentGroupIds.has(paymentGroupId)) {
              continue;
            }
            processedPaymentGroupIds.add(paymentGroupId);

            const receiptUrl = String(data.receiptUrl || '').trim();
            if (receiptUrl) {
              fileUrl = receiptUrl;
            } else {
              try {
                const ensured = await ensureReceiptUrlForPaymentGroup({
                  clientId,
                  condominiumId,
                  paymentGroupId,
                  source: 'massive_download',
                });
                fileUrl = ensured.receiptUrl;
                console.log(
                  `[sendReceiptsByEmail] Recibo regenerado/asegurado paymentGroupId=${paymentGroupId}, generated=${ensured.generated}`,
                );
              } catch (error) {
                console.error(
                  `[sendReceiptsByEmail] No se pudo asegurar recibo paymentGroupId=${paymentGroupId}:`,
                  error,
                );
                continue;
              }
            }

            fileName = `recibo-${safeNumber}-${year}-${monthString}-${safeResolvedUserName}-${sanitizeFileNamePart(paymentGroupId)}.pdf`;
          } else {
            const paymentGroupId = String(data.paymentGroupId || '').trim();
            if (paymentGroupId && processedPaymentGroupIds.has(paymentGroupId)) {
              continue;
            }
            if (paymentGroupId) {
              processedPaymentGroupIds.add(paymentGroupId);
            }

            const attachmentPayment = String(data.attachmentPayment || '').trim();
            if (!attachmentPayment) {
              continue;
            }

            let filePath = attachmentPayment;
            if (filePath.startsWith(storageBaseUrl)) {
              filePath = filePath.substring(storageBaseUrl.length);
            }

            if (processedFilePaths.has(filePath)) {
              continue;
            }
            processedFilePaths.add(filePath);

            fileName = `comprobante-${safeNumber}-${year}-${monthString}-${safeResolvedUserName}-${sanitizeFileNamePart(doc.id)}.pdf`;

            try {
              const bucket = admin.storage().bucket();
              const file = bucket.file(filePath);
              const [exists] = await file.exists();
              if (!exists) {
                console.error(`[sendReceiptsByEmail] El archivo ${filePath} no existe`);
                continue;
              }

              try {
                await file.makePublic();
              } catch (publicError) {
                console.log('[sendReceiptsByEmail] makePublic falló (continuando):', publicError);
              }

              fileUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
            } catch (storageError) {
              console.error('[sendReceiptsByEmail] Error de storage:', storageError);
              continue;
            }
          }

          if (!fileUrl || !fileName) {
            continue;
          }

          try {
            const response = await fetch(fileUrl);
            if (!response.ok) {
              console.error(
                `[sendReceiptsByEmail] Error al descargar ${fileUrl}: ${response.status}`,
              );
              continue;
            }

            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength === 0) {
              console.error('[sendReceiptsByEmail] Archivo vacío, omitido');
              continue;
            }

            const fileBuffer = Buffer.from(arrayBuffer);
            if (
              currentZipFileCount > 0 &&
              (currentZipFileCount >= MAX_FILES_PER_EMAIL ||
                currentZipRawBytes + fileBuffer.byteLength > MAX_RAW_BYTES_PER_CHUNK)
            ) {
              await flushZipChunk();
            }

            currentZip.file(fileName, fileBuffer);
            currentZipRawBytes += fileBuffer.byteLength;
            currentZipFileCount += 1;
            archivosAgregados += 1;
          } catch (error) {
            console.error('[sendReceiptsByEmail] Error descargando/agregando archivo:', error);
          }
        }

        await flushZipChunk();

        if (archivosAgregados === 0) {
          throw toHttpError(404, 'No se encontraron archivos para enviar por correo.');
        }

        const mailerSendApiKey = process.env.MAILERSEND_API_KEY;
        if (!mailerSendApiKey) {
          throw toHttpError(
            500,
            'MAILERSEND_API_KEY no está configurado en variables de entorno.',
          );
        }

        const mailerSend = new MailerSend({
          apiKey: mailerSendApiKey,
        });

        let emailsSent = 0;
        const linksGenerated: Array<{ part: number; url: string; storagePath: string }> = [];
        for (const payload of zipPayloads) {
          const uploaded = await uploadZipAndGetSignedUrl({
            clientId,
            condominiumId,
            yearMonth,
            docType,
            part: payload.part,
            totalParts: zipPayloads.length,
            zipBuffer: payload.zipBuffer,
          });
          linksGenerated.push({
            part: payload.part,
            url: uploaded.signedUrl,
            storagePath: uploaded.storagePath,
          });
        }

        const linksHtml = linksGenerated
          .map(
            (link) =>
              `<p style="font-size:14px;margin:8px 0;">Parte ${link.part}: <a href="${link.url}" target="_blank" rel="noopener noreferrer">Descargar ZIP</a></p>`,
          )
          .join('');

        const emailHtml = buildEmailHtml({
          recipientName: recipient.name,
          totalFiles: archivosAgregados,
          month: monthString,
          year,
          docType,
          bodyExtraHtml: `<p style="font-size:14px;">Se generaron enlaces seguros de descarga (vigencia: ${ZIP_SIGNED_URL_TTL_HOURS} horas).</p>${linksHtml}`,
        });

        const linksEmailParams = new EmailParams()
          .setFrom(
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setTo([new Recipient(recipient.email, recipient.name)])
          .setReplyTo(
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setSubject(`Tus documentos de pago para ${year}-${monthString}`)
          .setHtml(emailHtml);

        await mailerSend.email.send(linksEmailParams);
        emailsSent += 1;

        res.status(200).json({
          ok: true,
          message: 'Correo enviado correctamente con links de descarga.',
          data: {
            sentTo: recipient.email,
            totalFiles: archivosAgregados,
            docType,
            deliveryMode: 'signed_links',
            chunks: zipPayloads.length,
            emailsSent,
            linksGeneratedCount: linksGenerated.length,
          },
        });
      } catch (error: any) {
        const statusCode = Number(error?.statusCode || 500);
        console.error('[sendReceiptsByEmail] Error:', error);
        res.status(statusCode).json({
          ok: false,
          message: error?.message || 'Error interno en el servidor',
        });
      }
    });
  },
);

export const getPaymentReceipt = onRequest(
  {
    cors: true,
    region: 'us-central1',
    invoker: 'public',
    maxInstances: 20,
  },
  async (req: any, res: any) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    return corsHandler(req, res, async () => {
      try {
        const params = req.method === 'POST' ? req.body : req.query;

        const clientId = String(params.clientId || '').trim();
        const condominiumId = String(params.condominiumId || '').trim();
        const paymentGroupId = String(params.paymentGroupId || '').trim();
        const download = parseBoolean(params.download);

        if (!clientId || !condominiumId || !paymentGroupId) {
          throw toHttpError(
            400,
            'Parámetros requeridos: clientId, condominiumId, paymentGroupId.',
          );
        }

        await verifyAuthAndTenant(req, clientId);

        const ensured = await ensureReceiptUrlForPaymentGroup({
          clientId,
          condominiumId,
          paymentGroupId,
          source: 'on_demand_api',
        });

        if (download) {
          res.redirect(302, ensured.receiptUrl);
          return;
        }

        res.status(200).json({
          ok: true,
          data: {
            paymentGroupId,
            receiptUrl: ensured.receiptUrl,
            generated: ensured.generated,
          },
        });
      } catch (error: any) {
        const statusCode = Number(error?.statusCode || 500);
        console.error('[getPaymentReceipt] Error:', error);
        res.status(statusCode).json({
          ok: false,
          message: error?.message || 'Error interno en el servidor',
        });
      }
    });
  },
);

export const cleanupTemporaryReceiptZips = onSchedule(
  {
    schedule: 'every 2 hours',
    timeZone: 'Etc/UTC',
    region: 'us-central1',
    maxInstances: 1,
  },
  async () => {
    const startedAt = Date.now();
    const cutoffMs = Date.now() - RECEIPTS_ZIP_RETENTION_HOURS * 60 * 60 * 1000;
    const bucket = admin.storage().bucket();

    let scanned = 0;
    let deleted = 0;
    let failed = 0;
    let pageToken: string | undefined;

    try {
      do {
        const [files, nextQuery] = await bucket.getFiles({
          prefix: 'receipts-deliveries/',
          autoPaginate: false,
          maxResults: 500,
          pageToken,
        });

        pageToken = nextQuery?.pageToken;

        for (const file of files) {
          if (scanned >= RECEIPTS_CLEANUP_SCAN_LIMIT || deleted >= RECEIPTS_CLEANUP_DELETE_LIMIT) {
            pageToken = undefined;
            break;
          }

          scanned += 1;
          const filePath = String(file.name || '');
          if (!filePath || filePath.endsWith('/')) {
            continue;
          }

          let createdAtMs = Number.NaN;
          const listedTimeCreated = file.metadata?.timeCreated;
          if (listedTimeCreated) {
            createdAtMs = Date.parse(listedTimeCreated);
          }

          if (!Number.isFinite(createdAtMs)) {
            try {
              const [metadata] = await file.getMetadata();
              createdAtMs = Date.parse(String(metadata.timeCreated || ''));
            } catch (metadataError) {
              failed += 1;
              console.error(
                `[cleanupTemporaryReceiptZips] Error reading metadata for ${filePath}:`,
                metadataError,
              );
              continue;
            }
          }

          if (!Number.isFinite(createdAtMs)) {
            continue;
          }

          if (createdAtMs > cutoffMs) {
            continue;
          }

          try {
            await file.delete({ ignoreNotFound: true });
            deleted += 1;
          } catch (error) {
            failed += 1;
            console.error(
              `[cleanupTemporaryReceiptZips] Error deleting ${filePath}:`,
              error,
            );
          }
        }
      } while (pageToken);

      console.log(
        `[cleanupTemporaryReceiptZips] completed scanned=${scanned} deleted=${deleted} failed=${failed} retentionHours=${RECEIPTS_ZIP_RETENTION_HOURS} elapsedMs=${Date.now() - startedAt}`,
      );
    } catch (error) {
      console.error('[cleanupTemporaryReceiptZips] Fatal error:', error);
      throw error;
    }
  },
);

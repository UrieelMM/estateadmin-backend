import * as dotenv from 'dotenv';
dotenv.config();

// import * as functions from 'firebase-functions';
import { defineString, defineSecret } from 'firebase-functions/params';
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import * as admin from 'firebase-admin';
import { Storage } from '@google-cloud/storage';
const { MailerSend, EmailParams, Recipient, Sender } = require('mailersend');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
import { onRequest } from 'firebase-functions/v2/https';
import { persistReceiptPdfForPaymentGroup } from './receipts/receipt.utils';
// const cors = require('cors'); // No se utiliza con la configuración CORS de V2

const twilio = require('twilio');

admin.initializeApp();

const storage = new Storage();

const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_ACCOUNT_SID = defineString('TWILIO_ACCOUNT_SID');
const TWILIO_MESSAGING_SERVICE_SID = defineString(
  'TWILIO_MESSAGING_SERVICE_SID',
);

const tasksClient = new CloudTasksClient();
const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT || 'administracioncondominio-93419';
const QUEUE_NAME = 'emailQueue';
const LOCATION = 'us-central1';
// URL pública de la función HTTP que procesará la tarea
const serviceUrl = `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/processGroupPaymentEmail`;

// No se utiliza corsHandler con la configuración CORS de V2

// Función auxiliar para formatear números de teléfono mexicanos
const formatPhoneNumber = (phone: any): string => {
  if (!phone) return '';

  // Asegurarse de que phone sea una cadena de texto
  const phoneStr = String(phone);

  // Eliminar cualquier carácter que no sea número
  const cleanPhone = phoneStr.replace(/\D/g, '');

  // Si el número ya tiene el prefijo +521, lo devolvemos tal cual
  if (cleanPhone.startsWith('521')) {
    return `+${cleanPhone}`;
  }
  // Si el número comienza con 52, agregamos el 1
  if (cleanPhone.startsWith('52')) {
    return `+${cleanPhone}`;
  }
  // Si el número comienza con 1, agregamos el 52
  if (cleanPhone.startsWith('1')) {
    return `+52${cleanPhone}`;
  }
  // Para cualquier otro caso, asumimos que es un número local y agregamos +521
  return `+521${cleanPhone}`;
};

const toCents = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.round(parsed);
};

const resolveChargeCents = (payment: any): number => {
  const directCharge = toCents(payment?.chargeValue);
  if (directCharge !== 0) {
    return directCharge;
  }

  const paymentReference = toCents(payment?.paymentAmountReference);
  if (paymentReference !== 0) {
    return paymentReference;
  }

  const paid = toCents(payment?.amountPaid);
  const creditBalance = toCents(payment?.creditBalance);
  if (paid !== 0 || creditBalance !== 0) {
    return Math.max(paid - creditBalance, 0);
  }

  return 0;
};

const resolveSaldoCents = (payment: any): number => {
  const paid = toCents(payment?.amountPaid);
  const charge = resolveChargeCents(payment);
  const creditBalance = toCents(payment?.creditBalance);
  const amountPending = toCents(payment?.amountPending);

  const baseSaldo = paid - charge;
  if (baseSaldo !== 0) {
    return baseSaldo;
  }

  if (creditBalance !== 0) {
    return creditBalance;
  }

  if (amountPending !== 0) {
    return -amountPending;
  }

  return 0;
};

const buildConceptWithMonth = (payment: any): string => {
  let concept = payment?.concept || 'Sin concepto';
  if (payment?.startAt) {
    const parsedDate = new Date(String(payment.startAt).replace(' ', 'T'));
    if (!Number.isNaN(parsedDate.getTime())) {
      const monthNames = [
        'Enero',
        'Febrero',
        'Marzo',
        'Abril',
        'Mayo',
        'Junio',
        'Julio',
        'Agosto',
        'Septiembre',
        'Octubre',
        'Noviembre',
        'Diciembre',
      ];
      concept += ` - ${monthNames[parsedDate.getMonth()] || ''}`;
    }
  }
  return concept;
};

////////////////////////////////////////// SEND EMAIL FOR PARCEL //////////////////////////////////////////

// Exportación de la función para notificación de paquetes
export { onParcelReceptionCreated } from './parcel-receptions';

// Exportación de funciones para publicaciones
export { onPublicationCreated, processPublicationEmail } from './publications';

//TODO:SEND EMAIL FOR PAYMENT
////////////////////////////////////////// SEND EMAIL FOR PAYMENT //////////////////////////////////////////
exports.enviarEmailConPagoPDF = onDocumentCreated(
  '**/paymentsToSendEmail/{paymentId}',
  async (event: any) => {
    try {
      const snapshot = event.data;
      if (!snapshot) {
        console.log('No hay datos asociados al evento');
        return;
      }
      const paymentData = snapshot.data();

      // Extraer IDs desde el path de la nueva colección
      // Ruta: clients/{clientId}/condominiums/{condominiumId}/paymentsToSendEmail/{paymentId}
      const docPath = snapshot.ref.path;
      const pathSegments = docPath.split('/');
      const clientId = pathSegments[1];
      const condominiumId = pathSegments[3];
      const paymentId = pathSegments[5];

      // Extraer userUID y chargeUID desde el documento (fue insertado adicionalmente)
      const userUID = paymentData.userUID || paymentData.userId || '';
      const chargeUID = paymentData.chargeUID || '';

      // Crear una tarea para procesar el envío de correo con un retraso de 5 segundos
      const parent = tasksClient.queuePath(PROJECT_ID, LOCATION, QUEUE_NAME);
      const task: protos.google.cloud.tasks.v2.ITask = {
        httpRequest: {
          httpMethod: 'POST',
          url: serviceUrl,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(
            JSON.stringify({
              clientId,
              condominiumId,
              userUID,
              chargeUID,
              paymentGroupId: paymentData.paymentGroupId || paymentId,
              email: paymentData.email,
            }),
          ).toString('base64'),
        },
        scheduleTime: {
          seconds: Math.floor(Date.now() / 1000) + 5, // 5 segundos de retraso
        },
      };

      await tasksClient.createTask({ parent, task });
      console.log('Tarea creada para procesar el envío de correo');
    } catch (error) {
      console.error('Error al crear la tarea:', error);
    }
  },
);

//TODO: SEND EMAIL FOR RECEIPTS
// ////////////////////////////////////////// SEND EMAIL FOR RECEIPTS//////////////////////////////////////////
export {
  sendReceiptsByEmail,
  getPaymentReceipt,
  cleanupTemporaryReceiptZips,
} from './receipts/receipts.controller';

//TODO: SEND EMAIL FOR CALENDAR EVENTS
//////////////////////////////////////// SEND EMAIL FOR CALENDAR EVENTS //////////////////////////////////////////
export { onCalendarEventCreated } from './calendar-events';

//TODO: SEND EMAIL FOR INVOICES GENERATED
////////////////////////////////////////// SEND EMAIL FOR INVOICES GENERATED//////////////////////////////////////////
export { onInvoiceCreated } from './invoices/invoices.controller';

////////////////////////////////////////// SEND EMAIL FOR CONTACT FORM//////////////////////////////////////////
export { onContactFormSubmitted } from './contact/contact.controller';

////////////////////////////////////////// SEND EMAIL FOR CHARGE NOTIFICATIONS//////////////////////////////////////////
export { onChargeCreated, sendChargeEmail } from './charge-notifications';

//TODO:GENERATE PUBLIC FILE
////////////////////////////////////////// GENERATE PUBLIC FILE//////////////////////////////////////////
exports.makePaymentFilePublic = onObjectFinalized(
  { bucket: 'administracioncondominio-93419.appspot.com' },
  async (event: any) => {
    const fileData = event.data;
    const bucketName = fileData.bucket;
    const filePath = fileData.name; // Ej: "clients/{clientId}/condominiums/{condominiumId}/payments/{datePath}/{file.originalname}"

    console.log(`Procesando archivo: ${filePath} en el bucket: ${bucketName}`);

    // Verificar si el archivo está en la ruta "payments/"
    if (!filePath.includes('/payments/')) {
      console.log('El archivo no pertenece a la carpeta "payments", se omite.');
      return;
    }

    try {
      const file = storage.bucket(bucketName).file(filePath);
      // Forzamos que el objeto sea público
      await file.makePublic();
      console.log(`El archivo ${filePath} ahora es público.`);
    } catch (error) {
      console.error('Error al hacer público el archivo:', error);
    }
  },
);

// Función HTTP que procesará la tarea de envío de correo
export const processGroupPaymentEmail = onRequest(
  async (req: any, res: any) => {
    try {
      const {
        clientId,
        condominiumId,
        userUID,
        chargeUID: _chargeUID,
        paymentGroupId,
        email,
      } = req.body;

      const paymentsToSendEmailRef = admin
        .firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('paymentsToSendEmail');

      // Consultar la colección consolidada por paymentGroupId.
      // Fallback: buscar por docId cuando paymentGroupId viene como fallback desde el trigger.
      let paymentsQuerySnapshot = await paymentsToSendEmailRef
        .where('paymentGroupId', '==', paymentGroupId)
        .get();

      if (paymentsQuerySnapshot.empty && paymentGroupId) {
        const consolidatedByIdDoc = await paymentsToSendEmailRef
          .doc(paymentGroupId)
          .get();

        if (consolidatedByIdDoc.exists) {
          paymentsQuerySnapshot = {
            ...paymentsQuerySnapshot,
            empty: false,
            size: 1,
            docs: [consolidatedByIdDoc],
          } as any;
        }
      }

      if (paymentsQuerySnapshot.empty) {
        console.log('No se encontraron pagos.');
        return res.status(404).send('No se encontraron pagos');
      }
      // Asumimos que existe un único registro consolidado por grupo de pago.
      const consolidatedPaymentDoc = paymentsQuerySnapshot.docs[0];
      const consolidatedPayment = consolidatedPaymentDoc.data();

      // Obtener datos de la empresa y usuario
      const clientDoc = await admin
        .firestore()
        .collection('clients')
        .doc(clientId)
        .get();
      const clientData = clientDoc.data();
      if (!clientData) {
        console.log('No se encontraron datos de la empresa');
        return res.status(404).send('No se encontraron datos de la empresa');
      }
      const condominiumDoc = await admin
        .firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .get();
      const condominiumData = condominiumDoc.data() || {};
      const usersRef = admin
        .firestore()
        .collection(`clients/${clientId}/condominiums/${condominiumId}/users`);

      let userData: any = null;
      let userDocId = '';

      const normalizedUserUID = String(userUID || '').trim();
      if (normalizedUserUID) {
        const userDocByUid = await usersRef.doc(normalizedUserUID).get();
        if (userDocByUid.exists) {
          userData = userDocByUid.data() || {};
          userDocId = userDocByUid.id;
        }
      }

      if (!userData) {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (normalizedEmail) {
          const userSnapshotByEmail = await usersRef
            .where('email', '==', normalizedEmail)
            .limit(1)
            .get();
          if (!userSnapshotByEmail.empty) {
            userData = userSnapshotByEmail.docs[0].data() || {};
            userDocId = userSnapshotByEmail.docs[0].id;
          }
        }
      }

      if (!userData && consolidatedPayment?.userId) {
        const fallbackUserDoc = await usersRef
          .doc(String(consolidatedPayment.userId))
          .get();
        if (fallbackUserDoc.exists) {
          userData = fallbackUserDoc.data() || {};
          userDocId = fallbackUserDoc.id;
        }
      }

      const hasResolvedUser = !!userData;

      if (!hasResolvedUser) {
        console.log(
          'No se encontró el usuario por userUID/email/payment record. Se continuará solo con generación/persistencia de recibo:',
          userUID,
          email,
        );
        userData = {
          name:
            consolidatedPayment?.residentName ||
            consolidatedPayment?.name ||
            'Residente',
          lastName: String(
            consolidatedPayment?.residentLastName ||
              consolidatedPayment?.lastName ||
              '',
          ).trim(),
          email: String(email || consolidatedPayment?.email || '').trim(),
          tower: String(consolidatedPayment?.towerSnapshot || '').trim(),
          number: String(consolidatedPayment?.numberCondominium || '').trim(),
          notifications: {
            email: false,
            whatsapp: false,
          },
        };
      }

      const residentFullName = String(
        `${userData?.name || ''} ${userData?.lastName || ''}`.trim() ||
          userData?.name ||
          'Sin nombre',
      );

      const wantsEmailNotifications =
        hasResolvedUser && userData?.notifications?.email === true;
      const wantsWhatsappNotifications =
        hasResolvedUser && userData?.notifications?.whatsapp === true;
      let shouldSendEmail = wantsEmailNotifications;

      const resolvedPaymentGroupId = String(
        paymentGroupId ||
          consolidatedPayment?.paymentGroupId ||
          consolidatedPaymentDoc.id,
      );

      // Enviar notificación por WhatsApp
      if (wantsWhatsappNotifications) {
        try {
          // Obtener el número de WhatsApp del usuario
          const userPhone = userData.phoneNumber || userData.phone;
          if (userPhone) {
          // Helper para formatear a moneda mexicana (los valores vienen en centavos)
          const formatCurrency = (value: any) => {
            const num = (Number(value) || 0) / 100;
            return new Intl.NumberFormat('es-MX', {
              style: 'currency',
              currency: 'MXN',
              minimumFractionDigits: 2,
            }).format(num);
          };

          // Formatear la fecha y hora en hora local (America/Mexico_City)
          const currentDate = new Date();
          const options: Intl.DateTimeFormatOptions = {
            timeZone: 'America/Mexico_City',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          } as Intl.DateTimeFormatOptions;
          const formattedDate = currentDate.toLocaleDateString(
            'es-MX',
            options,
          );

          const formatSignedCurrency = (value: number) => {
            if (value > 0) {
              return `+${formatCurrency(value)}`;
            }
            return formatCurrency(value);
          };

          // Usar la misma lógica canónica de cálculo que PDF/HTML
          const paymentsArray = Array.isArray(consolidatedPayment.payments)
            ? consolidatedPayment.payments
            : [consolidatedPayment];

          const paymentRows = paymentsArray.map((payment) => {
            return {
              concept: buildConceptWithMonth(payment),
              paidCents: toCents(payment.amountPaid),
              chargeCents: resolveChargeCents(payment),
              saldoCents: resolveSaldoCents(payment),
            };
          });

          const totalMontoPagado = paymentRows.reduce(
            (sum, row) => sum + row.paidCents,
            0,
          );
          const totalCargos = paymentRows.reduce(
            (sum, row) => sum + row.chargeCents,
            0,
          );
          const totalSaldo = paymentRows.reduce(
            (sum, row) => sum + row.saldoCents,
            0,
          );

          // Preparar los datos para la plantilla
          const folio =
            consolidatedPayment.folio ||
            (consolidatedPayment.payments &&
              consolidatedPayment.payments[0]?.folio) ||
            'Sin folio';
          const fecha = formattedDate;
          const residente = residentFullName;
          const medioPago =
            consolidatedPayment.paymentType || 'No especificado';
          const totalPagado = formatCurrency(totalMontoPagado);
          const cargos = formatCurrency(totalCargos);
          const saldo = formatSignedCurrency(totalSaldo);

          // Preparar el detalle por concepto
          let detalleConceptos = paymentRows
            .map((paymentRow) => {
              return `• ${paymentRow.concept}: ${formatCurrency(paymentRow.paidCents)}`;
            })
            .join(' | ');

          // Verificar si el detalle excede el límite de caracteres (1600)
          const MAX_CHARS = 1600;
          if (detalleConceptos.length > MAX_CHARS) {
            // Truncar el detalle y agregar mensaje
            detalleConceptos =
              detalleConceptos.substring(0, MAX_CHARS - 30) +
              '... Más detalles en tu correo';
          }

          const accountSid = TWILIO_ACCOUNT_SID.value();
          const authToken = TWILIO_AUTH_TOKEN.value();
          const messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID.value();

          if (!accountSid || !authToken || !messagingServiceSid) {
            console.error(
              'Faltan credenciales de Twilio en las variables de entorno',
            );
            return;
          }

          // Inicializar el cliente de Twilio
          const clientTwilio = twilio(accountSid, authToken);

          // Enviar el mensaje usando el Messaging Service
          const message = await clientTwilio.messages.create({
            messagingServiceSid: messagingServiceSid,
            to: `whatsapp:${formatPhoneNumber(userPhone)}`,
            contentSid: 'HX689d4f847ff700caf528d6e95a81e185',
            contentVariables: JSON.stringify({
              1: folio,
              2: fecha,
              3: residente,
              4: medioPago,
              5: totalPagado,
              6: cargos,
              7: saldo,
              8: detalleConceptos,
            }),
          });

            console.log(`Mensaje de WhatsApp enviado con SID: ${message.sid}`);
          } else {
            console.log(
              `Notificación WhatsApp omitida por falta de teléfono para usuario ${userData.uid || userDocId || 'sin-uid'}`,
            );
          }
        } catch (whatsappError) {
          console.error(
            'Error al enviar el mensaje de WhatsApp:',
            whatsappError,
          );
        }
      } else {
        console.log(
          `Notificación WhatsApp desactivada para usuario ${userData.uid || userDocId || 'sin-uid'}`,
        );
      }

      if (!wantsEmailNotifications) {
        console.log(
          `Notificación por correo desactivada para usuario ${userData.uid || userDocId || 'sin-uid'}`,
        );
        shouldSendEmail = false;
      }

      if (!userData.email || !userData.email.includes('@')) {
        console.log(
          `Notificación por correo omitida por email inválido para usuario ${userData.uid || userDocId || 'sin-uid'}`,
        );
        shouldSendEmail = false;
      }

      // Helper para formatear a moneda mexicana (los valores vienen en centavos)
      const formatCurrency = (value: any) => {
        const num = toCents(value) / 100;
        return new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 2,
        }).format(num);
      };

      // ----- INICIO: GENERACIÓN DEL PDF -----
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Carta: 612x792 puntos
      const { width, height } = page.getSize();

      const colorInstitucional = rgb(0.39, 0.4, 0.95); // #6366F1
      const fontSizeTitle = 22;
      const fontSizeText = 12;
      const fontSizeSmall = 10;
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

      const formatSignedCurrency = (value: number) => {
        if (value > 0) {
          return `+${formatCurrency(value)}`;
        }
        return formatCurrency(value);
      };

      // Datos de encabezado/legales
      const companyLogoUrl = String(clientData.logoUrl || '').trim();
      const condominiumName = String(condominiumData.name || 'Sin nombre').trim();
      const condominiumAddress = String(
        condominiumData.address || 'Sin dirección',
      ).trim();
      const signatureUrl = String(condominiumData.signatureUrl || '').trim();
      const residentName = residentFullName;
      const residentTower = String(
        userData?.tower || consolidatedPayment?.towerSnapshot || '',
      ).trim();
      const residentNumber = String(
        userData?.number || consolidatedPayment?.numberCondominium || '',
      ).trim();
      const paymentMethod = String(
        consolidatedPayment.paymentType || 'No especificado',
      ).trim();
      const folioValue = String(
        consolidatedPayment.folio ||
          (consolidatedPayment.payments &&
            consolidatedPayment.payments[0]?.folio) ||
          'Sin folio',
      ).trim();

      // Header
      page.drawRectangle({
        x: 0,
        y: height - 90,
        width,
        height: 90,
        color: colorInstitucional,
      });
      page.drawText('Recibo de pago', {
        x: 20,
        y: height - 56,
        size: fontSizeTitle,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      // Logo más grande en el header (con sobreescalado controlado para mitigar márgenes)
      if (companyLogoUrl) {
        try {
          const logoResponse = await fetch(companyLogoUrl);
          if (logoResponse.ok) {
            const logoBytes = await logoResponse.arrayBuffer();
            const logoContentType = String(
              logoResponse.headers.get('content-type') || '',
            ).toLowerCase();
            const logoImage = logoContentType.includes('png')
              ? await pdfDoc.embedPng(logoBytes)
              : await pdfDoc.embedJpg(logoBytes);

            const logoBoxWidth = 230;
            const logoBoxHeight = 74;
            const fitScale = Math.min(
              logoBoxWidth / logoImage.width,
              logoBoxHeight / logoImage.height,
            );
            const overscale = 1.35;
            const drawWidth = logoImage.width * fitScale * overscale;
            const drawHeight = logoImage.height * fitScale * overscale;
            const drawX = width - logoBoxWidth - 16 + (logoBoxWidth - drawWidth) / 2;
            const drawY = height - 86 + (logoBoxHeight - drawHeight) / 2;

            page.drawImage(logoImage, {
              x: drawX,
              y: drawY,
              width: drawWidth,
              height: drawHeight,
            });
          }
        } catch (logoError) {
          console.error('[processGroupPaymentEmail] Error al cargar logo:', logoError);
        }
      }

      // Datos legales del recibo
      let infoY = height - 120;
      const infoStep = 18;
      const drawInfoLine = (label: string, value: string) => {
        page.drawText(`${label}: ${value || 'N/A'}`, {
          x: 20,
          y: infoY,
          size: fontSizeText,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        infoY -= infoStep;
      };

      drawInfoLine('Condominio', condominiumName);
      drawInfoLine('Dirección', condominiumAddress);
      drawInfoLine('Folio', folioValue);
      drawInfoLine('Condómino', residentName);
      drawInfoLine('Torre', residentTower || 'N/A');
      drawInfoLine('Número / Departamento / Casa', residentNumber || 'N/A');
      drawInfoLine('Medio de pago', paymentMethod);

      // Construir filas de pagos para PDF
      const paymentsArray = Array.isArray(consolidatedPayment.payments)
        ? consolidatedPayment.payments
        : [consolidatedPayment];

      const paymentRows = paymentsArray.map((payment) => {
        const paidCents = toCents(payment.amountPaid);
        const chargeCents = resolveChargeCents(payment);
        const saldoCents = resolveSaldoCents(payment);
        return {
          concept: buildConceptWithMonth(payment),
          paidCents,
          chargeCents,
          saldoCents,
        };
      });

      const totalMontoPagado = paymentRows.reduce(
        (sum, row) => sum + row.paidCents,
        0,
      );
      const totalCargos = paymentRows.reduce((sum, row) => sum + row.chargeCents, 0);
      const totalSaldo = paymentRows.reduce((sum, row) => sum + row.saldoCents, 0);

      // Tabla de conceptos
      const tableX = 15;
      const tableWidth = 582;
      const col1Width = 265;
      const col2Width = 105;
      const col3Width = 105;
      const cellHeight = 26;
      const cellPadding = 8;
      const tableYStart = infoY - 24;

      page.drawRectangle({
        x: tableX,
        y: tableYStart,
        width: tableWidth,
        height: cellHeight,
        color: colorInstitucional,
      });
      page.drawText('Concepto', {
        x: tableX + 6,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText('Monto Pagado', {
        x: tableX + col1Width + 6,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText('Cargos', {
        x: tableX + col1Width + col2Width + 6,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText('Saldo', {
        x: tableX + col1Width + col2Width + col3Width + 6,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      let currentY = tableYStart - cellHeight;
      let rowIndex = 0;
      for (const paymentRow of paymentRows) {
        if (rowIndex % 2 === 1) {
          page.drawRectangle({
            x: tableX,
            y: currentY,
            width: tableWidth,
            height: cellHeight,
            color: rgb(0.96, 0.96, 0.96),
          });
        }

        page.drawRectangle({
          x: tableX,
          y: currentY,
          width: tableWidth,
          height: cellHeight,
          borderColor: rgb(0.85, 0.85, 0.85),
          borderWidth: 0.5,
        });

        page.drawText(paymentRow.concept, {
          x: tableX + 6,
          y: currentY + cellPadding,
          size: fontSizeSmall,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        page.drawText(formatCurrency(paymentRow.paidCents), {
          x: tableX + col1Width + 6,
          y: currentY + cellPadding,
          size: fontSizeSmall,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        page.drawText(formatCurrency(paymentRow.chargeCents), {
          x: tableX + col1Width + col2Width + 6,
          y: currentY + cellPadding,
          size: fontSizeSmall,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        page.drawText(formatSignedCurrency(paymentRow.saldoCents), {
          x: tableX + col1Width + col2Width + col3Width + 6,
          y: currentY + cellPadding,
          size: fontSizeSmall,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });

        currentY -= cellHeight;
        rowIndex += 1;
      }

      // Totales
      page.drawRectangle({
        x: tableX,
        y: currentY,
        width: tableWidth,
        height: cellHeight,
        borderColor: colorInstitucional,
        borderWidth: 1,
      });
      page.drawText('Total:', {
        x: tableX + 6,
        y: currentY + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(formatCurrency(totalMontoPagado), {
        x: tableX + col1Width + 6,
        y: currentY + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(formatCurrency(totalCargos), {
        x: tableX + col1Width + col2Width + 6,
        y: currentY + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(formatSignedCurrency(totalSaldo), {
        x: tableX + col1Width + col2Width + col3Width + 6,
        y: currentY + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(0, 0, 0),
      });

      // Firma del administrador
      const signatureTopY = currentY - 90;
      const signatureBoxWidth = 190;
      const signatureBoxHeight = 70;
      const signatureX = width - signatureBoxWidth - 36;

      if (signatureUrl) {
        try {
          const signatureResponse = await fetch(signatureUrl);
          if (signatureResponse.ok) {
            const signatureBytes = await signatureResponse.arrayBuffer();
            const signatureContentType = String(
              signatureResponse.headers.get('content-type') || '',
            ).toLowerCase();
            const signatureImage = signatureContentType.includes('png')
              ? await pdfDoc.embedPng(signatureBytes)
              : await pdfDoc.embedJpg(signatureBytes);
            const signatureDims = signatureImage.scaleToFit(
              signatureBoxWidth,
              signatureBoxHeight,
            );

            page.drawImage(signatureImage, {
              x: signatureX + (signatureBoxWidth - signatureDims.width) / 2,
              y: signatureTopY,
              width: signatureDims.width,
              height: signatureDims.height,
            });
          }
        } catch (signatureError) {
          console.error(
            '[processGroupPaymentEmail] Error al cargar signatureUrl:',
            signatureError,
          );
        }
      }

      page.drawLine({
        start: { x: signatureX, y: signatureTopY - 8 },
        end: { x: signatureX + signatureBoxWidth, y: signatureTopY - 8 },
        thickness: 1,
        color: rgb(0, 0, 0),
      });
      page.drawText('Firma del administrador', {
        x: signatureX + 22,
        y: signatureTopY - 24,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      const pdfBytes = await pdfDoc.save();
      const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

      // Persistir receiptUrl para descarga inmediata y masiva.
      try {
        const receiptPersistResult = await persistReceiptPdfForPaymentGroup({
          clientId,
          condominiumId,
          paymentGroupId: resolvedPaymentGroupId,
          pdfBytes,
          source: 'processGroupPaymentEmail',
        });
        console.log(
          `[processGroupPaymentEmail] Recibo persistido paymentGroupId=${resolvedPaymentGroupId} receiptUrl=${receiptPersistResult.receiptUrl} updatedConsolidated=${receiptPersistResult.updatedConsolidated} updatedPayments=${receiptPersistResult.updatedPayments}`,
        );
      } catch (receiptPersistError) {
        console.error(
          `[processGroupPaymentEmail] Error al persistir receiptUrl para paymentGroupId=${resolvedPaymentGroupId}:`,
          receiptPersistError,
        );
      }
      // ----- FIN: GENERACIÓN DEL PDF -----

      // --- GENERAR HTML DEL CORREO CON DETALLE DE PAGOS ---
      // Se elimina la columna de "Medio de pago" en la tabla y se agrega un bloque aparte con dicho dato.
      const paymentsDetailsHtml = paymentRows
        .map((paymentRow) => {
          return `
        <tr style="border-bottom:1px solid #ddd;">
          <td style="padding:8px; text-align:left;">${paymentRow.concept}</td>
          <td style="padding:8px; text-align:right;">${formatCurrency(paymentRow.paidCents)}</td>
          <td style="padding:8px; text-align:right;">${formatCurrency(paymentRow.chargeCents)}</td>
          <td style="padding:8px; text-align:right;">${formatSignedCurrency(paymentRow.saldoCents)}</td>
        </tr>
      `;
        })
        .join('');

      const totalsRow = `
      <tr style="font-weight:bold; border-top:2px solid #6366F1;">
        <td style="padding:8px; text-align:left;">Total:</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(totalMontoPagado)}</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(totalCargos)}</td>
        <td style="padding:8px; text-align:right;">${formatSignedCurrency(totalSaldo)}</td>
      </tr>
    `;

      const emailHtml = `
      <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { font-family: 'Open Sans', sans-serif; margin:0; padding:0; background-color: #f6f6f6; }
              .container { width: 90%; max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 10px; padding: 20px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
              .header { background-color: #6366F1; padding: 20px; border-radius: 10px 10px 0 0; text-align: center; }
              .header img { width: 100px; height: auto; }
              .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
              .content { padding: 20px; }
              .details-table { width: 100%; border-collapse: collapse; }
              .details-table th, .details-table td { padding:8px; border-bottom: 1px solid #ddd; text-align: left; }
              .details-table th { background-color: #6366F1; color: #ffffff; text-align: left; }
              .details-table tr:nth-child(odd) { background-color: #f9f9f9; }
              .button { background-color: #6366F1; color: #ffffff; text-decoration: none; padding: 15px; display: block; text-align: center; border-radius: 5px; margin: 20px 0; }
              .footer { text-align: center; font-size: 14px; color: #666666; margin-top: 20px; }
              @media (max-width: 600px) {
                .header h1 { font-size: 20px; }
                .details-table th, .details-table td { font-size: 12px; padding: 5px; }
                .button { padding: 10px; font-size: 16px; }
                .container { padding: 10px; }
              }
            </style>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,600;0,700;0,800&display=swap" rel="stylesheet">
          </head>
          <body>
            <div class="container">
              <div class="header">
                <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
                <h1>¡Confirmación de Pago Recibido!</h1>
              </div>
              <div class="content" style="padding:20px; background-color: #f6f6f6; margin-top:20px; border-radius: 10px;">
                <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${residentFullName}</h2>
                <p style="color:#1a1a1a; font-size:16px;">Hemos registrado ${paymentsArray.length > 1 ? 'tus pagos' : 'tu pago'} exitosamente.</p>
                <table class="details-table">
                  <tr>
                    <th>Concepto</th>
                    <th>Monto Pagado</th>
                    <th>Cargo</th>
                    <th>Saldo</th>
                  </tr>
                  ${paymentsDetailsHtml}
                  ${totalsRow}
                </table>
                <!-- Nueva fila para mostrar la fecha de pago usando paymentDate -->
                <table style="width:100%; border-collapse: collapse; margin-top: 20px;">
                  <tr>
                    <td style="padding:8px; text-align:left; color: #1a1a1a; border-bottom: 1px solid #ddd; border-top: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">
                      Fecha de pago: ${
                        consolidatedPayment.paymentDate
                          ? (() => {
                              const pd = consolidatedPayment.paymentDate.toDate
                                ? consolidatedPayment.paymentDate.toDate()
                                : new Date(consolidatedPayment.paymentDate);
                              return pd.toLocaleDateString('es-ES');
                            })()
                          : 'No especificada'
                      }
                    </td>
                  </tr>
                </table>
                <!-- Nueva fila para mostrar el medio de pago -->
                <table style="width:100%; border-collapse: collapse; margin-top: 10px;">
                  <tr>
                    <td style="padding:8px; text-align:left; color: #1a1a1a; border-bottom: 1px solid #ddd; border-top: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">
                      Medio de pago: ${paymentsArray[0].paymentType || 'No especificado'}
                    </td>
                  </tr>
                </table>
                <table style="width:100%;">
                    <tr>
                      <td>
                        <p style="font-size:12px;color:#ffffff;margin-top:20px; font-weight:bold; background-color: #6366F1;border-radius:10px;padding:20px;text-align:center">Adjunto encontrarás el recibo de pago.</p>
                      </td>
                    </tr>
                  </table>
              </div>
              <div class="footer" >
                <div class="footer" style="background-color:#f6f6f6;border-radius:10px 10px 0 0;padding:10px;text-align:center; color:#1a1a1a">
                <p>Modernidad y Eficacia en la Administración</p>
                <p>Síguenos en nuestras redes sociales: 
                  <a href="URL_FACEBOOK" style="color:#6366F1; text-decoration:none;">Facebook</a> | 
                  <a href="URL_TWITTER" style="color:#6366F1; text-decoration:none;">Twitter</a> | 
                  <a href="URL_INSTAGRAM" style="color:#6366F1; text-decoration:none;">Instagram</a>
                </p>
                <p>Omnipixel</p>
              </div>
            </div>
          </body>
        </html>
    `;

      if (!shouldSendEmail) {
        console.log(
          `[processGroupPaymentEmail] Recibo generado y persistido para paymentGroupId=${resolvedPaymentGroupId}. Correo omitido.`,
        );
        return res
          .status(200)
          .send('Recibo generado y persistido. Correo omitido.');
      }

      // Enviar correo
      const mailerSend = new MailerSend({
        apiKey:
          'mlsn.3611aa51c08f244faf71131ceb627e193d3f57183323b0cb39538532bd6abfa7',
      });

      const emailParams = new EmailParams()
        .setFrom(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setTo([
          new Recipient(
            userData.email || 'Sin email',
            residentFullName,
          ),
        ])
        .setReplyTo(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setSubject('¡Confirmación de Pago Recibido!')
        .setHtml(emailHtml)
        .setAttachments([
          {
            filename: 'recibo-pago.pdf',
            content: pdfBase64,
            type: 'application/pdf',
            disposition: 'attachment',
          },
        ]);

      await mailerSend.email.send(emailParams);
      console.log(
        `Correo enviado exitosamente con el recibo de pago en PDF a ${userData.email}`,
      );

      return res.status(200).send('Correo enviado exitosamente');
    } catch (error) {
      console.error('Error al enviar el correo con el recibo de pago:', error);
      res.status(500).send('Error al procesar el envío de correo');
    }
  },
);

// Exportar la función desde el nuevo archivo
export { rateLimitedGetQRData } from './qr/qr.controller';

// Exportar la función desde el nuevo archivo
export { sendNotificationMorosidad } from './notifications/notifications.controller';

// Motor de notificaciones in-app (Bloque 2)
export {
  onNotificationEventCreated,
  retryStaleNotificationEvents,
} from './notification-dispatch';

// Exportar las funciones de super admin desde el nuevo archivo
export {
  verifySuperAdminAccess,
  validateSuperAdminSession,
  superAdminOperation,
} from './super-admin/super-admin.controller';

// Exportar las funciones para reportes de comité
export {
  onCommitteeMemberCreated,
  onCommitteeMemberUpdated,
  sendScheduledReports,
  sendTestReport,
  sendTestFinancialReport,
} from './committee-reports/committee-reports.controller';

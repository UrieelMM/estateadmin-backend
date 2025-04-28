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
      const userUID = paymentData.userUID || '';
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
export { sendReceiptsByEmail } from './receipts/receipts.controller';

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
      // Renombramos userUID a userId para evitar el error de TS.
      const {
        clientId,
        condominiumId,
        userUID: _userId,
        chargeUID: _chargeUID,
        paymentGroupId,
        email,
      } = req.body;

      // Consultar la colección consolidada
      const paymentsQuerySnapshot = await admin
        .firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('paymentsToSendEmail')
        .where('paymentGroupId', '==', paymentGroupId)
        .get();

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
      const usersRef = admin
        .firestore()
        .collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
      const userSnapshot = await usersRef.where('email', '==', email).get();
      if (userSnapshot.empty) {
        console.log('No se encontró un usuario con el email:', email);
        return res.status(404).send('No se encontró el usuario');
      }
      const userData = userSnapshot.docs[0].data();
      if (!userData.email || !userData.email.includes('@')) {
        console.error('Email inválido:', userData.email);
        return res.status(400).send('Email inválido');
      }

      // Enviar notificación por WhatsApp
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

          // Calcular totales
          let totalMontoPagado = 0;
          let totalCargos = 0;
          let totalSaldo = 0;

          // Usar paymentsArray del registro consolidado
          let paymentsArray = [];
          if (
            consolidatedPayment.payments &&
            Array.isArray(consolidatedPayment.payments)
          ) {
            paymentsArray = consolidatedPayment.payments;
          } else {
            paymentsArray.push(consolidatedPayment);
          }

          // Calcular totales usando el valor de chargeValue que ahora se guarda en paymentsToSendEmail
          paymentsArray.forEach((payment) => {
            totalMontoPagado += Number(payment.amountPaid) || 0;
            // Usar el chargeValue que ahora se guarda en el documento
            totalCargos += Number(payment.chargeValue) || 0;
          });

          // Si hay un chargeValue en el documento consolidado, usarlo directamente
          if (consolidatedPayment.chargeValue) {
            totalCargos = Number(consolidatedPayment.chargeValue) || 0;
          }

          // Calcular saldo como la diferencia entre monto pagado y cargo
          totalSaldo = totalMontoPagado - totalCargos;

          // Preparar los datos para la plantilla
          const folio =
            consolidatedPayment.folio ||
            (consolidatedPayment.payments &&
              consolidatedPayment.payments[0]?.folio) ||
            'Sin folio';
          const fecha = formattedDate;
          const residente = userData.name;
          const medioPago =
            consolidatedPayment.paymentType || 'No especificado';
          const totalPagado = formatCurrency(totalMontoPagado);
          const cargos = formatCurrency(totalCargos);
          const saldo = formatCurrency(totalSaldo);

          // Preparar el detalle por concepto
          let detalleConceptos = paymentsArray
            .map((payment) => {
              let concepto = payment.concept || 'Sin concepto';
              if (payment.startAt) {
                const d = new Date(payment.startAt.replace(' ', 'T'));
                const monthIndex = d.getMonth();
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
                const monthName = monthNames[monthIndex] || '';
                concepto += ` - ${monthName}`;
              }
              return `• ${concepto}: $${(Number(payment.amountPaid) / 100).toFixed(2)}`;
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
        }
      } catch (whatsappError) {
        console.error('Error al enviar el mensaje de WhatsApp:', whatsappError);
      }

      // Helper para formatear a moneda mexicana (los valores vienen en centavos)
      const formatCurrency = (value: any) => {
        const num = (Number(value) || 0) / 100;
        return new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 2,
        }).format(num);
      };

      // ----- INICIO: GENERACIÓN DEL PDF CON ESTILOS MODERNOS -----
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Carta: 612x792 puntos
      const { width, height } = page.getSize();

      const colorInstitucional = rgb(0.39, 0.4, 0.95); // #6366F1
      const fontSizeTitle = 22;
      const fontSizeText = 14;
      const fontSizeSmall = 12;
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

      // Marca de agua
      const watermarkUrl =
        'https://firebasestorage.googleapis.com/v0/b/administracioncondominio-93419.appspot.com/o/estateAdminUploads%2Fassets%2FEstateAdminWatteMark.png?alt=media&token=653a790b-d7f9-4324-8c6d-8d1eaf9d5924';
      const watermarkBytes = await fetch(watermarkUrl).then((res) =>
        res.arrayBuffer(),
      );
      const watermarkImage = await pdfDoc.embedPng(watermarkBytes);
      const watermarkDims = watermarkImage.scaleToFit(
        width * 0.8,
        height * 0.8,
      );
      page.drawImage(watermarkImage, {
        x: (width - watermarkDims.width) / 2,
        y: (height - watermarkDims.height) / 2,
        width: watermarkDims.width,
        height: watermarkDims.height,
        opacity: 0.1,
      });

      // Datos de la empresa
      const companyLogoUrl = clientData.logoUrl || '';
      const companyEmail = clientData.email || 'Sin correo';
      const companyPhone = clientData.phoneNumber || 'Sin teléfono';
      const companyName =
        clientData.companyName || clientData.name || 'Sin nombre de empresa';

      page.drawText(companyName, {
        x: 20,
        y: height - 40,
        size: fontSizeSmall,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(`Correo: ${companyEmail} | Teléfono: ${companyPhone}`, {
        x: 20,
        y: height - 60,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      // Logo
      let logoImage, logoDims;
      try {
        const logoImageBytes = await fetch(companyLogoUrl).then((res) =>
          res.arrayBuffer(),
        );
        logoImage = await pdfDoc.embedPng(logoImageBytes);
        logoDims = logoImage.scaleToFit(100, 50);
      } catch (error) {
        console.error('Error al cargar el logo, usando valores por defecto');
      }

      // Header con fondo institucional
      page.drawRectangle({
        x: 0,
        y: height - 80,
        width: width,
        height: 80,
        color: colorInstitucional,
      });
      page.drawText('Recibo de pago', {
        x: 20,
        y: height - 50,
        size: fontSizeTitle,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      if (logoImage && logoDims) {
        page.drawImage(logoImage, {
          x: width - 120,
          y: height - 75,
          width: logoDims.width,
          height: logoDims.height,
        });
      }

      // Fecha y hora de procesamiento (ajustado: etiqueta, font-size y color)
      const currentDate = new Date();
      const options: Intl.DateTimeFormatOptions = {
        timeZone: 'America/Mexico_City',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      };
      const formattedDateTime = currentDate.toLocaleString('es-MX', options);
      const [dateProcessed, timeProcessed] = formattedDateTime.split(', ');
      page.drawText(
        `Fecha en que se procesó el pago: ${dateProcessed || 'Sin fecha'} ${timeProcessed || 'Sin hora'}`,
        {
          x: 20,
          y: height - 120,
          size: 10,
          font: fontRegular,
          color: rgb(0.502, 0.502, 0.502),
        },
      );

      // Folio (ajustado con 9px de separación desde la fecha de procesamiento)
      const folioValue =
        consolidatedPayment.folio ||
        (consolidatedPayment.payments &&
          consolidatedPayment.payments[0]?.folio) ||
        'Sin folio';
      page.drawText(`Folio: ${folioValue}`, {
        x: 20,
        y: height - 138, // 120 + 18 (separación)
        size: fontSizeText,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      // Fecha de pago (ajustado con 9px de separación desde el folio)
      if (consolidatedPayment.paymentDate) {
        const paymentDateObj = consolidatedPayment.paymentDate.toDate
          ? consolidatedPayment.paymentDate.toDate()
          : new Date(consolidatedPayment.paymentDate);
        const paymentDateFormatted = paymentDateObj.toLocaleDateString('es-ES');
        page.drawText(`Fecha de pago: ${paymentDateFormatted}`, {
          x: 20,
          y: height - 165, // 138 + 27 (separación)
          size: fontSizeText,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
      }

      // Nombre del residente (ajustado con 9px de separación desde la fecha de pago)
      page.drawText(`Nombre del residente: ${userData.name || 'Sin nombre'}`, {
        x: 20,
        y: height - 192, // 165 + 27 (separación)
        size: fontSizeText,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      // Medio de pago (ajustado con 9px de separación desde el nombre del residente)
      page.drawText(
        `Medio de pago: ${consolidatedPayment.paymentType || 'No especificado'}`,
        {
          x: 20,
          y: height - 219, // 192 + 27 (separación)
          size: fontSizeText,
          font: fontRegular,
          color: rgb(0, 0, 0),
        },
      );

      // --- TABLA DE PAGOS EN EL PDF ---
      // Definir columnas: Concepto (200 px), Monto Pagado (120 px), Saldo Pendiente (120 px) y Saldo a favor (120 px)
      const tableX = 15;
      const tableWidth = 582;
      const col1Width = 200;
      const col2Width = 120;
      const col3Width = 120;
      const cellHeight = 30;
      const cellPadding = 12;
      const tableYStart = height - 290;

      // Encabezado de la tabla
      page.drawRectangle({
        x: tableX,
        y: tableYStart,
        width: tableWidth,
        height: cellHeight,
        color: colorInstitucional,
      });
      page.drawText('Concepto', {
        x: tableX + 5,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText('Monto Pagado', {
        x: tableX + col1Width + 5,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText('Cargos', {
        x: tableX + col1Width + col2Width + 5,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText('Saldo', {
        x: tableX + col1Width + col2Width + col3Width + 5,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      let totalMontoPagado = 0;
      let totalCargos = 0;
      let currentY = tableYStart - cellHeight;
      let rowIndex = 0;

      // Usar paymentsArray del registro consolidado (si es array; de lo contrario, empaquetarlo)
      let paymentsArray = [];
      if (
        consolidatedPayment.payments &&
        Array.isArray(consolidatedPayment.payments)
      ) {
        paymentsArray = consolidatedPayment.payments;
      } else {
        paymentsArray.push(consolidatedPayment);
      }

      // Calcular totales usando el valor de chargeValue que ahora se guarda en paymentsToSendEmail
      paymentsArray.forEach((payment) => {
        totalMontoPagado += Number(payment.amountPaid) || 0;
        // Usar el chargeValue que ahora se guarda en el documento
        totalCargos += Number(payment.chargeValue) || 0;
      });

      // Si hay un chargeValue en el documento consolidado, usarlo directamente
      if (consolidatedPayment.chargeValue) {
        totalCargos = Number(consolidatedPayment.chargeValue) || 0;
      }

      // Calcular el saldo total como la diferencia entre monto pagado y cargos
      const totalSaldo = totalMontoPagado - totalCargos;

      // Iterar sobre cada pago individual para construir la tabla en el PDF
      for (const payment of paymentsArray) {
        // Asegurarse de que cada pago tenga un valor de cargo válido
        // Si no existe chargeValue en el pago individual, usar una parte proporcional del total
        if (!payment.chargeValue && totalMontoPagado > 0) {
          payment.chargeValue =
            (Number(payment.amountPaid) / totalMontoPagado) * totalCargos;
        }

        // Usar directamente el concepto almacenado
        let conceptoRow = payment.concept || 'Sin concepto';
        // Modificación: usar startAt para determinar el mes
        if (payment.startAt) {
          const d = new Date(payment.startAt.replace(' ', 'T'));
          const monthIndex = d.getMonth();
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
          const monthName = monthNames[monthIndex] || '';
          conceptoRow += ` - ${monthName}`;
        }

        // Reducir en dos puntos el font size del contenido de la tabla
        const tableFontSize = fontSizeText - 2;

        // Si la fila es impar, se sombrea con un fondo claro
        if (rowIndex % 2 === 1) {
          page.drawRectangle({
            x: tableX,
            y: currentY,
            width: tableWidth,
            height: cellHeight,
            color: rgb(0.95, 0.95, 0.95),
          });
        }

        // Dibujar la fila con borde delgado
        page.drawRectangle({
          x: tableX,
          y: currentY,
          width: tableWidth,
          height: cellHeight,
          borderColor: colorInstitucional,
          borderWidth: 1,
        });
        page.drawText(conceptoRow, {
          x: tableX + 5,
          y: currentY + cellPadding,
          size: tableFontSize,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        page.drawText(formatCurrency(payment.amountPaid), {
          x: tableX + col1Width + 5,
          y: currentY + cellPadding,
          size: tableFontSize,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        // Mostrar el valor de chargeValue para cada fila individual
        page.drawText(formatCurrency(payment.chargeValue || 0), {
          x: tableX + col1Width + col2Width + 5,
          y: currentY + cellPadding,
          size: tableFontSize,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        // Calcular el saldo para cada pago como la diferencia entre monto pagado y cargo
        const saldoPago =
          Number(payment.amountPaid || 0) - Number(payment.chargeValue || 0);
        page.drawText(formatCurrency(saldoPago), {
          x: tableX + col1Width + col2Width + col3Width + 5,
          y: currentY + cellPadding,
          size: tableFontSize,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        currentY -= cellHeight;
        rowIndex++;
      }

      // Fila de Totales
      const tableFontSizeTotals = fontSizeText - 2;
      page.drawRectangle({
        x: tableX,
        y: currentY,
        width: tableWidth,
        height: cellHeight,
        borderColor: colorInstitucional,
        borderWidth: 1,
      });
      page.drawText('Total:', {
        x: tableX + 5,
        y: currentY + cellPadding,
        size: tableFontSizeTotals,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(formatCurrency(totalMontoPagado), {
        x: tableX + col1Width + 5,
        y: currentY + cellPadding,
        size: tableFontSizeTotals,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(formatCurrency(totalCargos), {
        x: tableX + col1Width + col2Width + 5,
        y: currentY + cellPadding,
        size: tableFontSizeTotals,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      // El saldo total ya se calculó anteriormente
      page.drawText(formatCurrency(totalSaldo), {
        x: tableX + col1Width + col2Width + col3Width + 5,
        y: currentY + cellPadding,
        size: tableFontSizeTotals,
        font: fontBold,
        color: rgb(0, 0, 0),
      });

      // --- SELLO Y FOOTER DEL PDF (se mantienen sin cambios significativos) ---
      const selloY = currentY - 175;
      const selloUrl =
        'https://firebasestorage.googleapis.com/v0/b/administracioncondominio-93419.appspot.com/o/estateAdminUploads%2Fassets%2FpagoSello.png?alt=media&token=88993c72-34fc-4d6e-8c15-93f4a58eea0a';
      const selloBytes = await fetch(selloUrl).then((res) => res.arrayBuffer());
      const selloImage = await pdfDoc.embedPng(selloBytes);
      const selloDims = selloImage.scale(0.35); // Aumentado de 0.25 a 0.35 para hacer el sello más grande
      page.drawImage(selloImage, {
        x: width - selloDims.width - 50,
        y: selloY,
        width: selloDims.width,
        height: selloDims.height,
      });

      const footerY = 0;
      page.drawRectangle({
        x: 0,
        y: footerY,
        width: width,
        height: 100,
        color: colorInstitucional,
      });
      page.drawText('Gracias por su pago.', {
        x: 20,
        y: footerY + 80,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText(
        'Para cualquier duda o aclaración, contacte a su empresa administradora:',
        {
          x: 20,
          y: footerY + 60,
          size: fontSizeSmall,
          font: fontRegular,
          color: rgb(1, 1, 1),
        },
      );
      page.drawText(`Correo: ${companyEmail}`, {
        x: 20,
        y: footerY + 40,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(1, 1, 1),
      });
      page.drawText(`Teléfono: ${companyPhone}`, {
        x: 350,
        y: footerY + 40,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(1, 1, 1),
      });
      //Alinear a la izquierda
      page.drawText('Un servicio de Omnipixel', {
        x: 20,
        y: footerY + 20,
        size: fontSizeSmall,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      const pdfBytes = await pdfDoc.save();
      const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
      // ----- FIN: GENERACIÓN DEL PDF -----

      // --- GENERAR HTML DEL CORREO CON DETALLE DE PAGOS ---
      // Se elimina la columna de "Medio de pago" en la tabla y se agrega un bloque aparte con dicho dato.
      let paymentsDetailsHtml = '';
      // Calcular totales para el HTML
      let htmlTotalMontoPagado = 0;
      let htmlTotalCargos = 0;
      let htmlTotalSaldo = 0;

      // Usar paymentsArray del registro consolidado para el HTML
      let htmlPaymentsArray = [];
      if (
        consolidatedPayment.payments &&
        Array.isArray(consolidatedPayment.payments)
      ) {
        htmlPaymentsArray = consolidatedPayment.payments;
      } else {
        htmlPaymentsArray.push(consolidatedPayment);
      }

      // Calcular totales usando el valor de chargeValue que ahora se guarda en paymentsToSendEmail
      htmlPaymentsArray.forEach((payment) => {
        htmlTotalMontoPagado += Number(payment.amountPaid) || 0;
        // Usar el chargeValue que ahora se guarda en el documento
        htmlTotalCargos += Number(payment.chargeValue) || 0;
      });

      // Si hay un chargeValue en el documento consolidado, usarlo directamente
      if (consolidatedPayment.chargeValue) {
        htmlTotalCargos = Number(consolidatedPayment.chargeValue) || 0;
      }

      // Calcular saldo como la diferencia entre monto pagado y cargo
      htmlTotalSaldo = htmlTotalMontoPagado - htmlTotalCargos;

      htmlPaymentsArray.forEach((payment) => {
        // Asegurarse de que cada pago tenga un valor de cargo válido
        // Si no existe chargeValue en el pago individual, usar una parte proporcional del total
        if (!payment.chargeValue && htmlTotalMontoPagado > 0) {
          payment.chargeValue =
            (Number(payment.amountPaid) / htmlTotalMontoPagado) *
            htmlTotalCargos;
        }

        let concepto = payment.concept || 'Sin concepto';
        // Modificación: usar startAt para determinar el mes
        if (payment.startAt) {
          const d = new Date(payment.startAt.replace(' ', 'T'));
          const monthIndex = d.getMonth();
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
          const monthName = monthNames[monthIndex] || '';
          concepto += ` ${monthName}`;
        }
        const montoPagado = formatCurrency(payment.amountPaid);
        const montoCargo = formatCurrency(payment.chargeValue || 0);
        const saldoIndividual = formatCurrency(
          (Number(payment.amountPaid) || 0) -
            (Number(payment.chargeValue) || 0),
        );
        paymentsDetailsHtml += `
        <tr style="border-bottom:1px solid #ddd;">
          <td style="padding:8px; text-align:left;">${concepto}</td>
          <td style="padding:8px; text-align:right;">${montoPagado}</td>
          <td style="padding:8px; text-align:right;">${montoCargo}</td>
          <td style="padding:8px; text-align:right;">${saldoIndividual}</td>
        </tr>
      `;
      });

      // Calcular el saldo como la diferencia entre monto pagado y cargo
      htmlTotalSaldo = htmlTotalMontoPagado - htmlTotalCargos;

      const totalsRow = `
      <tr style="font-weight:bold; border-top:2px solid #6366F1;">
        <td style="padding:8px; text-align:left;">Total:</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(htmlTotalMontoPagado)}</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(htmlTotalCargos)}</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(htmlTotalSaldo)}</td>
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
                <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${userData.name || 'Sin nombre'}</h2>
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

      // Enviar correo
      const mailerSend = new MailerSend({
        apiKey:
          'mlsn.0cda1e684fe67e14b7b569d23fc3d66bcb1950417ef2eb9f18007246c6e5a57a',
      });

      const emailParams = new EmailParams()
        .setFrom(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
        )
        .setTo([
          new Recipient(
            userData.email || 'Sin email',
            userData.name || 'Sin nombre',
          ),
        ])
        .setReplyTo(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
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

      res.status(200).send('Correo enviado exitosamente');
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

// Exportar las funciones de super admin desde el nuevo archivo
export {
  verifySuperAdminAccess,
  validateSuperAdminSession,
  superAdminOperation,
} from './super-admin/super-admin.controller';

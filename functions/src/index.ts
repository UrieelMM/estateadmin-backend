import * as dotenv from 'dotenv';
dotenv.config();

// import * as functions from 'firebase-functions';
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import * as admin from 'firebase-admin';
import { Storage } from '@google-cloud/storage';
const { MailerSend, EmailParams, Recipient, Sender } = require('mailersend');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
import { onRequest } from 'firebase-functions/v2/https';
const cors = require('cors');
// const JSZip = require('jszip');
const twilio = require('twilio');

admin.initializeApp();

const storage = new Storage();

const tasksClient = new CloudTasksClient();
const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT || 'administracioncondominio-93419';
const QUEUE_NAME = 'emailQueue';
const LOCATION = 'us-central1';
// URL pública de la función HTTP que procesará la tarea
const serviceUrl = `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/processGroupPaymentEmail`;

const corsHandler = cors({ origin: true });

// Función auxiliar para formatear números de teléfono mexicanos
const formatPhoneNumber = (phone: string): string => {
  if (!phone) return '';
  // Eliminar cualquier carácter que no sea número
  const cleanPhone = phone.replace(/\D/g, '');
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

// exports.enviarEmailPorPublicacion = functions.firestore
//   .document('clients/{clientId}/condominiums/{condominiumId}/publications/{publicationId}')
//   .onCreate(async (snapshot: { data: () => any; }, context: { params: { clientId: any; condominiumId: any; }; }) => {
//     const publicationData = snapshot.data();
//     const { clientId, condominiumId } = context.params;

//     const mailerSend = new MailerSend({
//       apiKey: 'mlsn.0cda1e684fe67e14b7b569d23fc3d66bcb1950417ef2eb9f18007246c6e5a57a',
//     });

//     const usersRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
//     const emailPromises: any[] = [];

//     try {
//       const usersSnapshot = await usersRef.get();

//       usersSnapshot.docs.forEach((userDoc: { data: () => any; }) => {
//         const userData = userDoc.data();

//         // Determinar si el correo debe enviarse al usuario
//         let shouldSendEmail = false;
//         if (publicationData.sendTo === 'todos') {
//           shouldSendEmail = true;
//         } else if (Array.isArray(publicationData.sendTo)) {
//           const fullName = `${userData.name} ${userData.lastName}`;
//           shouldSendEmail = publicationData.sendTo.includes(fullName);
//         } else {
//           shouldSendEmail = publicationData.sendTo === userData.role;
//         }

//         if (userData.email && shouldSendEmail) {
//           const htmlTemplate = (
//             userData: any,
//             publicationData: { title: any; content: any, condominiumName: any; },
//             attachmentUrls: any[],
//           ) => `
//           <html>
//           <head>
//             <style>
//               :root {
//                 font-family: 'Open Sans', sans-serif;
//               }
//               .button {
//                 background-color: #6366F1;
//                 color: white;
//                 padding: 20px;
//                 text-align: center;
//                 text-decoration: none;
//                 display: inline-block;
//                 border-radius: 5px;
//                 margin-top: 20px;
//                 color: #ffffff !important;
//                 font-size: 18px;
//                 font-weight: bold;
//                 width: 350px;
//               }
//               .footer-link {
//                 color: #6366F1 !important;
//                 text-decoration: none;
//               }
//             </style>
//             <link rel="preconnect" href="https://fonts.googleapis.com">
//             <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
//             <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
//           </head>
//           <body style="background-color: #f6f6f6;">
//             <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
//             <tr>
//               <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
//                 <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
//             </td>
//             </tr>
//             <tr>
//               <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
//                 <h1 style="color: white; margin: 0; font-size: 24px;">Hay una nueva publicación</h1>
//               </td>
//             </tr>
//               <tr>
//                 <td style="padding: 20px 0; text-align: center;">
//                   <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
//                     <tr>
//                       <td style=" border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
//                         <h2 style="color: #6366F1; font-size: 20px;">Hola, ${userData.name} Tu comunidad ${publicationData.condominiumName} ha emitido una nueva publicación</h2>
//                       </td>
//                     </tr>
//                     <tr>
//                       <td style="padding: 10px 0; font-size: 22px; font-weight: bold; font-size: 18px;" width="200">${publicationData.title}</td>
//                     </tr>
//                     <tr>
//                       <td style="padding: 10px 0; font-size: 20px; font-size: 16px;">${publicationData.content}</td>
//                     </tr>
//                     <tr>
//                       <td style="text-align: center;">
//                         <a href="https://www.urieel.dev" class="button">Ir a mi cuenta</a>
//                       </td>
//                     </tr>
//                     ${attachmentUrls && attachmentUrls.length > 0
//               ? `<tr>
//                             <td style="text-align: center; padding-top: 20px;">
//                               <h4 style="font-weight: bold">Archivos adjuntos:</h4>
//                               ${attachmentUrls.map((url, index) => `<p><a href="${url}" style="color: #6366F1; font-size: 16px; margin: 10px 0;">Archivo Adjunto ${index + 1}</a></p>`).join("")}
//                             </td>
//                           </tr>`
//               : ""
//             }
//                   </table>
//                 </td>
//               </tr>
//               <tr>
//                 <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
//                   <img style="width: 100px; height: 100px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46" alt="Omnipixel">
//                   <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
//                 </td>
//               </tr>
//               <tr>
//                 <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
//                   <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
//                   <p>
//                     <a href="URL_FACEBOOK" class="footer-link">Facebook</a> |
//                     <a href="URL_TWITTER" class="footer-link">Twitter</a> |
//                     <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
//                   </p>
//                   <p>© Omnipixel</p>
//                 </td>
//               </tr>
//             </table>
//           </body>
//         </html>
//       `;
//           let emailHtml = htmlTemplate(
//             userData,
//             publicationData,
//             publicationData.attachmentPublications,
//           );

//           const emailParams = new EmailParams()
//             .setFrom(
//               new Sender(
//                 'MMS_CUXpzj@estate-admin.com',
//                 'EstateAdmin Support',
//               ),
//             )
//             .setTo([new Recipient(userData.email, userData.name || '')])
//             .setReplyTo(
//               new Sender(
//                 'MS_CUXpzj@estate-admin.com',
//                 'EstateAdmin Support',
//               ),
//             )
//             .setSubject(`Nueva publicación en ${publicationData.condominiumName}: ${publicationData.title}`)
//             .setHtml(emailHtml);

//           emailPromises.push(mailerSend.email.send(emailParams));
//         }
//       });

//       await Promise.all(emailPromises);
//       console.log(`Correos enviados exitosamente a los usuarios del condominio ${condominiumId}`);
//     } catch (error) {
//       console.error(`Error al enviar correos electrónicos al condominio ${condominiumId}:`, error);
//     }
//   });

////////////////////////////////////////// SEND EMAIL FOR PARCEL //////////////////////////////////////////

// exports.enviarEmailPorRecepcionPaqueteria = functions.firestore
//   .document('clients/{clientId}/condominiums/{condominiumId}/parcelReceptions/{parcelReceptionId}')
//   .onCreate(async (snapshot: { data: () => any; }, context: { params: { clientId: any; condominiumId: any; parcelReceptionId: any; }; }) => {
//     try {
//       const parcelData = snapshot.data();
//       const { clientId, condominiumId } = context.params;

//       console.log('1 Datos del paquete:', parcelData);

//       const mailerSend = new MailerSend({
//         apiKey: 'mlsn.0cda1e684fe67e14b7b569d23fc3d66bcb1950417ef2eb9f18007246c6e5a57a',
//       });

//       const usersRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
//       const emailPromises: any[] = [];

//       const usersSnapshot = await usersRef.get();

//       usersSnapshot.docs.forEach((userDoc: { data: () => any; }) => {
//         const userData = userDoc.data();

//         // Determinar si el correo debe enviarse al usuario
//         let shouldSendEmail = false;

//         // Lógica para determinar si se debe enviar el correo al usuario
//         // Comprueba si el nombre y número coinciden con los datos del paquete
//         if (userData.email === parcelData.email) {
//           console.log('3 El paquete es para el usuario', userData.name, userData.number);
//           shouldSendEmail = true;
//         }

//         if (userData.email && shouldSendEmail) {
//           console.log('Enviando correo electrónico a', userData.email);
//           // Plantilla HTML del correo electrónico para el aviso de paquete
//           const htmlTemplate = (
//             userData: any,
//             parcelData: any,
//           ) => `
//           <html>
//             <head>
//                 <style>
//                 :root {
//                     font-family: 'Open Sans', sans-serif;
//                 }
//                 .button {
//                     background-color: #6366F1;
//                     color: white;
//                     padding: 20px;
//                     text-align: center;
//                     text-decoration: none;
//                     display: inline-block;
//                     border-radius: 5px;
//                     margin-top: 20px;
//                     color: #ffffff !important;
//                     font-size: 18px;
//                     font-weight: bold;
//                     width: 350px;
//                 }
//                 .footer-link {
//                     color: #6366F1 !important;
//                     text-decoration: none;
//                 }
//                 </style>
//                 <link rel="preconnect" href="https://fonts.googleapis.com">
//                 <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
//                 <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
//             </head>
//       <body style="background-color: #f6f6f6;">
//           <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
//           <tr>
//           <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
//               <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
//           </td>
//           </tr>
//           <tr>
//           <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
//               <h1 style="color: white; margin: 0; font-size: 24px;">Tu paquete te espera</h1>
//           </td>
//           </tr>
//           <tr>
//               <td style="padding: 20px 0; text-align: center;">
//               <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
//                   <tr>
//                   <td style=" border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
//                       <h2 style="color: #6366F1; font-size: 20px;">Hola, ${userData.name} <br> Tienes un paquete esperando a ser recogido en la recepción</h2>
//                   </td>
//                   </tr>
//                   <tr>
//                       <td style="padding: 10px 0; font-size: 20px; font-size: 16px;">Día y hora de la recepción: ${parcelData.dateReception} ${parcelData.hourReception} <br> <br> <br>
//                           <p style="width: 100%; margin: 0 auto; padding: 10px 0; font-size: 14px; background-color: #6366F1; color: white; border-radius: 10px; font-weight: bold;">Nota: Recuerda presentar una identificación oficial para poder recoger el paquete</p>
//                       </td>
//                   </tr>
//               </table>
//               </td>
//           </tr>
//           <tr>
//               <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
//               <img style="width: 100px; height: 100px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46" alt="Omnipixel">
//               <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
//               </td>
//           </tr>
//           <tr>
//               <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
//               <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
//               <p>
//                   <a href="URL_FACEBOOK" class="footer-link">Facebook</a> |
//                   <a href="URL_TWITTER" class="footer-link">Twitter</a> |
//                   <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
//               </p>
//               <p>© Omnipixel</p>
//               </td>
//           </tr>
//           </table>
//         </body>
//     </html>
//           `;
//           let emailHtml = htmlTemplate(
//             userData,
//             parcelData,
//           );

//           const emailParams = new EmailParams()
//             .setFrom(
//               new Sender(
//                 'MS_CUXpzj@estate-admin.com',
//                 'EstateAdmin Support',
//               ),
//             )
//             .setTo([new Recipient(userData.email, userData.name || '')])
//             .setReplyTo(
//               new Sender(
//                 'MS_CUXpzj@estate-admin.com',
//                 'EstateAdmin Support',
//               ),
//             )
//             .setSubject(`¡Tienes un nuevo paquete en la recepción!`)
//             .setHtml(emailHtml);

//           emailPromises.push(mailerSend.email.send(emailParams));
//         }
//       });

//       await Promise.all(emailPromises);
//       console.log(`Correos enviados exitosamente a los usuarios del condominio ${condominiumId} sobre el paquete recibido`);
//     } catch (error) {
//       console.error(`Error al enviar correos electrónicos sobre el paquete recibido:`, error);
//     }
//   });
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

////////////////////////////////////////// SEND WHATSAPP FOR PAYMENT //////////////////////////////////////////

// exports.enviarWhatsAppConPago = functions.firestore
//   .document(
//     'clients/{clientId}/condominiums/{condominiumId}/payments/{paymentId}',
//   )
//   .onCreate(async (snapshot, context) => {
//     try {
//       // 1. Extraer datos del pago y parámetros de la ruta
//       const paymentData = snapshot.data();
//       const { clientId, condominiumId, paymentId } = context.params;

//       // 2. Obtener datos de la empresaa
//       const clientDoc = await admin
//         .firestore()
//         .collection('clients')
//         .doc(clientId)
//         .get();
//       const clientData = clientDoc.data();
//       if (!clientData) {
//         console.log('No se encontraron datos de la empresa');
//         return;
//       }

//       // 3. Obtener datos del usuario (buscando por el email del pago)
//       const usersRef = admin
//         .firestore()
//         .collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
//       const userSnapshot = await usersRef
//         .where('email', '==', paymentData.email)
//         .get();
//       if (userSnapshot.empty) {
//         console.log(
//           'No se encontró un usuario con el email:',
//           paymentData.email,
//         );
//         return;
//       }
//       const userData = userSnapshot.docs[0].data();

//       // 4. Generar el folio (por ejemplo: EA-001, EA-002, etc.)
//       const paymentCountSnapshot = await admin
//         .firestore()
//         .collection('clients')
//         .collection('condominiums')
//         .doc(condominiumId)
//         .collection('payments')
//         .get();
//       const folio = `EA-${String(paymentCountSnapshot.size + 1).padStart(3, '0')}`;

//       // 5. Formatear la fecha y hora en hora local (America/Mexico_City)
//       const currentDate = new Date();
//       const options: Intl.DateTimeFormatOptions = {
//         timeZone: 'America/Mexico_City',
//         year: 'numeric',
//         month: '2-digit',
//         day: '2-digit',
//         hour: '2-digit',
//         minute: '2-digit',
//         second: '2-digit',
//       } as Intl.DateTimeFormatOptions;
//       const formattedDateTime = currentDate.toLocaleString('es-MX', options);
//       const [dateProcessed, timeProcessed] = formattedDateTime.split(', ');

//       // 6. Convertir el mes de pago (formato "YYYY-MM") a nombre de mes (por ejemplo: "Agosto 2024")
//       const monthNames = [
//         'Enero',
//         'Febrero',
//         'Marzo',
//         'Abril',
//         'Mayo',
//         'Junio',
//         'Julio',
//         'Agosto',
//         'Septiembre',
//         'Octubre',
//         'Noviembre',
//         'Diciembre',
//       ];
//       // Se asume que paymentData.month tiene formato "YYYY-MM"
//       const [yearStr, monthStr] = paymentData.month.split('-');
//       const monthName = `${monthNames[parseInt(monthStr, 10) - 1]} ${yearStr}`;

//       // 7. Crear el cuerpo del mensaje de WhatsApp con los detalles del pago
//       const messageBody = `Nuevo pago registrado:
//                           ID de Pago: ${paymentId}
//                          Folio: ${folio}
//                           Fecha de procesamiento: ${dateProcessed} ${timeProcessed}
//                           Nombre del residente: ${userData.name}
//                          Medio de pago: Transferencia
//                          Mes pagado: ${monthName}
//                           Monto Pagado: $${paymentData.amountPaid}
//                           Saldo Pendiente: $${paymentData.amountPending}
//                            ¡Gracias por tu pago!`;

//       // 8. Inicializar el cliente de Twilio usando las credenciales de las variables de entorno
//       const accountSid = functions.config().twilio.account_sid;
//       const authToken = functions.config().twilio.auth_token;
//       const whatsappFrom = functions.config().twilio.whatsapp_from; // Ejemplo: 'whatsapp:+14155238886'
//       const clientTwilio = twilio(accountSid, authToken);

//       // 9. Definir el número de WhatsApp destino (fijo para pruebas)
//       const whatsappTo = 'whatsapp:+5215531139560';

//       console.log('whatsapp_from:', functions.config().twilio.whatsapp_from);

//       // 10. Enviar el mensaje de WhatsApp
//       const message = await clientTwilio.messages.create({
//         from: whatsappFrom,
//         to: whatsappTo,
//         body: messageBody,
//       });

//       console.log(`Mensaje de WhatsApp enviado con SID: ${message.sid}`);
//     } catch (error) {
//       console.error('Error al enviar el mensaje de WhatsApp:', error);
//     }
//   });

//TODO: SEND EMAIL FOR RECEIPTS
// ////////////////////////////////////////// SEND EMAIL FOR RECEIPTS//////////////////////////////////////////
// exports.sendReceiptsByEmail = functions.https.onRequest(async (req, res) => {
//   corsHandler(req, res, async () => {
//     // Manejo de solicitudes preflight (OPTIONS)
//     if (req.method === 'OPTIONS') {
//       res.set('Access-Control-Allow-Methods', 'GET, POST');
//       res.set('Access-Control-Allow-Headers', 'Content-Type');
//       res.status(204).send('');
//       return;
//     }

//     try {
//       // Extraer parámetros de la query
//       const year = req.query.year as string;
//       const month = req.query.month as string;
//       const clientId = req.query.clientId as string;
//       const condominiumId = req.query.condominiumId as string;
//       const email = req.query.email as string;
//       const docType = req.query.docType as string;

//       if (!year || !month || !clientId || !condominiumId || !email || !docType) {
//         res.status(400).send('Faltan parámetros necesarios: year, month, clientId, condominiumId, email y docType.');
//         return;
//       }

//       // Formatear mes a dos dígitos y construir el campo compuesto yearMonth
//       const monthString = month.padStart(2, '0');
//       const yearMonth = `${year}-${monthString}`;

//       // Consulta en collectionGroup usando el campo compuesto
//       const snapshot = await admin.firestore().collectionGroup('payments')
//         .where('yearMonth', '==', yearMonth)
//         .where('condominiumId', '==', condominiumId)
//         .where('email', '==', email)
//         .where('clientId', '==', clientId)
//         .get();

//       if (snapshot.empty) {
//         res.status(404).send('No se encontraron documentos para la fecha indicada.');
//         return;
//       }

//       const zip = new JSZip();
//       const storageBaseUrl = "https://storage.googleapis.com/administracioncondominio-93419.appspot.com/";

//       // Recorrer todos los documentos devueltos sin filtrar nuevamente por año
//       for (const doc of snapshot.docs) {
//         const data = doc.data();
//         let fileUrl = null;

//         if (docType === 'recibos') {
//           fileUrl = data.receiptUrl ? String(data.receiptUrl) : null;
//         } else {
//           if (data.attachmentPayment) {
//             let filePath = String(data.attachmentPayment);
//             if (filePath.startsWith(storageBaseUrl)) {
//               filePath = filePath.substring(storageBaseUrl.length);
//             }
//             const bucket = admin.storage().bucket();
//             const file = bucket.file(filePath);
//             const [signedUrl] = await file.getSignedUrl({
//               action: 'read',
//               expires: Date.now() + 60 * 60 * 1000,
//             });
//             fileUrl = signedUrl;
//           } else {
//             console.log(`Se omite el documento ${doc.id} por falta de archivo adjunto.`);
//             continue;
//           }
//         }

//         if (fileUrl) {
//           try {
//             const response = await fetch(fileUrl);
//             if (!response.ok) {
//               console.error(`Error al descargar el archivo para ${doc.id}: ${response.statusText}`);
//               continue;
//             }
//             const arrayBuffer = await response.arrayBuffer();
//             const fileBuffer = Buffer.from(arrayBuffer);
//             const numberCondominium = data.numberCondominium ? String(data.numberCondominium) : 'unknown';
//             const fileName = `numero-${numberCondominium}-${year}-${monthString}-${doc.id}.pdf`;
//             zip.file(fileName, fileBuffer);
//           } catch (error) {
//             console.error(`Error procesando el documento ${doc.id}:`, error);
//           }
//         }
//       }

//       const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

//       const htmlTemplate = (userData: any, receiptsInfo: any) => `
//             <html>
//               <head>
//                   <style>
//                     :root { font-family: 'Open Sans', sans-serif; }
//                     .button {
//                         background-color: #6366F1; color: white; padding: 20px; text-align: center;
//                         text-decoration: none; display: inline-block; border-radius: 5px; margin-top: 20px;
//                         font-size: 18px; font-weight: bold; width: 350px;
//                     }
//                     .footer-link { color: #6366F1 !important; text-decoration: none; }
//                   </style>
//                   <link rel="preconnect" href="https://fonts.googleapis.com">
//                   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
//                   <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
//               </head>
//               <body style="background-color: #f6f6f6;">
//                   <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto;
//                       box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
//                   <tr>
//                     <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
//                       <img style="width: 140px; height: 140px; object-fit: contain;"
//                           src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521"
//                           alt="EstateAdmin">
//                     </td>
//                   </tr>
//                   <tr>
//                     <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
//                       <h1 style="color: white; margin: 0; font-size: 24px;">Tus documentos están disponibles</h1>
//                     </td>
//                   </tr>
//                   <tr>
//                       <td style="padding: 20px 0; text-align: center;">
//                         <p style="font-size: 16px;">Hola, ${userData.name}, adjunto encontrarás los documentos de pago correspondientes al mes ${receiptsInfo.month} del año ${receiptsInfo.year}.</p>
//                         <p style="font-size: 14px;">Revisa el archivo adjunto para ver todos los documentos.</p>
//                       </td>
//                   </tr>
//                   <tr>
//                       <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
//                         <img style="width: 100px; height: 100px; object-fit: contain;"
//                             src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46"
//                             alt="Omnipixel">
//                         <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
//                       </td>
//                   </tr>
//                   <tr>
//                       <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
//                         <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
//                         <p>
//                             <a href="URL_FACEBOOK" class="footer-link">Facebook</a> |
//                             <a href="URL_TWITTER" class="footer-link">Twitter</a> |
//                             <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
//                         </p>
//                         <p>© Omnipixel</p>
//                       </td>
//                   </tr>
//                   </table>
//               </body>
//             </html>
//       `;

//       const userData = {
//         name: email,
//         email: email,
//       };

//       const receiptsInfo = { year: year, month: monthString };
//       const emailHtml = htmlTemplate(userData, receiptsInfo);

//       const mailerSend = new MailerSend({
//         apiKey: 'mlsn.0cda1e684fe67e14b7b569d23fc3d66bcb1950417ef2eb9f18007246c6e5a57a',
//       });

//       const emailParams = new EmailParams()
//         .setFrom(new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'))
//         .setTo([new Recipient(userData.email, userData.name)])
//         .setReplyTo(new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'))
//         .setSubject(`Tus documentos de pago para ${year}-${monthString}`)
//         .setHtml(emailHtml)
//         .setAttachments([
//           {
//             filename: `documentos_${year}-${monthString}.zip`,
//             content: zipBuffer.toString('base64'),
//           },
//         ]);

//       await mailerSend.email.send(emailParams);
//       res.send('Correo enviado correctamente');
//     } catch (error) {
//       console.error("Error en sendReceiptsByEmail:", error);
//       res.status(500).send('Error interno en el servidor');
//     }
//   });
// });

//TODO: SEND EMAIL FOR CALENDAR EVENTS
//////////////////////////////////////// SEND EMAIL FOR CALENDAR EVENTS //////////////////////////////////////////
export const enviarEmailPorCalendarEvent = onDocumentCreated(
  'clients/{clientId}/condominiums/{condominiumId}/calendarEvents/{calendarEventId}',
  async (event: any) => {
    try {
      const snapshot = event.data;
      if (!snapshot) {
        console.log('No hay datos asociados al evento');
        return;
      }
      const eventData = snapshot.data();
      const { clientId, condominiumId } = event.params;

      // Solo enviar correo si el registro tiene el campo "email"
      if (!eventData.email) {
        console.log(
          "No se encontró el campo 'email' en el registro; no se enviará correo.",
        );
        return null;
      }

      // Obtener datos del usuario
      const usersRef = admin
        .firestore()
        .collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
      const userSnapshot = await usersRef
        .where('email', '==', eventData.email)
        .get();

      if (userSnapshot.empty) {
        console.error(
          'No se encontró el usuario con el email:',
          eventData.email,
        );
        return null;
      }

      const userData = userSnapshot.docs[0].data();
      if (!userData) {
        console.error('No se encontraron datos del usuario');
        return null;
      }

      // Enviar notificación por WhatsApp
      try {
        const userPhone = userData.phoneNumber || userData.phone;
        if (userPhone) {
          const messageBody = `🎉 *EstateAdmin - Nuevo Evento Registrado*

📋 *Detalles del Evento*
━━━━━━━━━━━━━━━━━━━━
📅 Fecha: ${eventData.eventDay || 'No especificada'}
🕒 Horario: ${eventData.startTime || 'No especificado'} - ${eventData.endTime || 'No especificado'}
🏢 Área: ${eventData.commonArea || 'No especificada'}
👤 Residente: ${userData.name || 'No especificado'}

📝 *Información Adicional*
━━━━━━━━━━━━━━━━━━━━
📌 Nombre del Evento: ${eventData.name || 'No especificado'}
${eventData.comments ? `💬 Comentarios: ${eventData.comments}` : ''}

✅ Tu reserva ha sido registrada exitosamente.`;

          const accountSid = 'AC5577bf20cfdb715733d8fd1ab61505dc';
          const authToken = '0d2d04e187940f3e92798a3260476f0f';
          const messagingServiceSid = 'MG6b7af612a6554e34fce9e09a744f907b';

          if (!accountSid || !authToken || !messagingServiceSid) {
            console.error(
              'Faltan credenciales de Twilio en las variables de entorno',
            );
            return;
          }

          // Inicializar el cliente de Twilio
          const clientTwilio = twilio(accountSid, authToken);

          // Enviar el mensaje de WhatsApp usando el Messaging Service
          const message = await clientTwilio.messages.create({
            messagingServiceSid: messagingServiceSid,
            to: `whatsapp:${formatPhoneNumber(userPhone)}`,
            body: messageBody,
          });

          console.log(`Mensaje de WhatsApp enviado con SID: ${message.sid}`);
        }
      } catch (whatsappError) {
        console.error('Error al enviar el mensaje de WhatsApp:', whatsappError);
      }

      const mailerSend = new MailerSend({
        apiKey: process.env.MAILERSEND_API_KEY,
      });

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
                <h1>Nuevo Evento Registrado</h1>
              </div>
              <div class="content" style="padding:20px; background-color: #f6f6f6; margin-top:20px; border-radius: 10px;">
                <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${userData.name || 'Residente'}</h2>
                <p style="color:#1a1a1a; font-size:16px;">Se ha registrado un nuevo evento en el condominio.</p>
                <table class="details-table">
                  <tr>
                    <th>Detalle</th>
                    <th>Información</th>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Nombre del Evento</td>
                    <td>${eventData.name || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Número de Residente</td>
                    <td>${eventData.number || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Área Reservada</td>
                    <td>${eventData.commonArea || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Fecha del Evento</td>
                    <td>${eventData.eventDay || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Horario</td>
                    <td>${eventData.startTime || 'N/A'} - ${eventData.endTime || 'N/A'}</td>
                  </tr>
                  ${
                    eventData.comments
                      ? `
                  <tr>
                    <td style="font-weight:bold;">Comentarios</td>
                    <td>${eventData.comments}</td>
                  </tr>
                  `
                      : ''
                  }
                </table>
                <table style="width:100%;">
                  <tr>
                    <td>
                      <p style="font-size:12px;color:#ffffff;margin-top:20px; font-weight:bold; background-color: #6366F1;border-radius:10px;padding:20px;text-align:center">
                        Tu reserva ha sido registrada exitosamente.
                      </p>
                    </td>
                  </tr>
                </table>
              </div>
              <div class="footer">
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
            </div>
          </body>
        </html>
      `;

      const emailParams = new EmailParams()
        .setFrom(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
        )
        .setTo([new Recipient(eventData.email, userData.name || 'Residente')])
        .setReplyTo(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
        )
        .setSubject(`Nuevo Evento en Condominio ${condominiumId}`)
        .setHtml(emailHtml);

      await mailerSend.email.send(emailParams);
      console.log(`Correo enviado exitosamente a ${eventData.email}`);
      return null;
    } catch (error) {
      console.error('Error al procesar el evento:', error);
      return null;
    }
  },
);

//TODO:SEND EMAIL FOR INVOICES GENERATED
////////////////////////////////////////// SEND EMAIL FOR INVOICES GENERATED//////////////////////////////////////////
export const onInvoiceCreated = onDocumentCreated(
  {
    document:
      'clients/{clientId}/condominiums/{condominiumId}/invoicesGenerated/{invoiceId}',
  },
  async (event: any) => {
    // event.data es el DocumentSnapshot y event.params contiene los parámetros de la ruta
    const snap = event.data;
    const invoiceData = snap.data();
    const { clientId, condominiumId, invoiceId } = event.params as {
      clientId: string;
      condominiumId: string;
      invoiceId: string;
    };

    // Se espera que la factura tenga el UID del usuario al que se le debe notificar
    const userUID = invoiceData?.userUID;
    if (!userUID) {
      console.error('No se encontró userUID en la factura');
      return null;
    }

    try {
      // Recupera el documento del usuario directamente mediante su UID
      const userDocRef = admin
        .firestore()
        .doc(
          `clients/${clientId}/condominiums/${condominiumId}/users/${userUID}`,
        );
      const userDoc = await userDocRef.get();

      if (!userDoc.exists) {
        console.error('No se encontró usuario con UID:', userUID);
        return null;
      }

      const userData = userDoc.data();
      if (!userData) {
        console.error('No se encontraron datos del usuario');
        return null;
      }

      // Obtenemos el token FCM, si existe
      const fcmToken = userData.fcmToken;

      // Obtener datos de la factura
      const amount = invoiceData.amount ? invoiceData.amount : 'N/A';
      const dueDate = invoiceData.dueDate
        ? new Date(invoiceData.dueDate).toLocaleDateString()
        : 'N/A';
      const optionalMessage = invoiceData.optionalMessage
        ? invoiceData.optionalMessage
        : '';

      // Construir el cuerpo de la notificación
      const bodyMessage = `Monto: ${amount}. Vence: ${dueDate}. ${optionalMessage}`;

      // Si existe el token, enviar la notificación push
      if (fcmToken) {
        const message = {
          notification: { title: 'Nueva factura generada', body: bodyMessage },
          data: { invoiceId: invoiceId },
          token: fcmToken,
        };

        const response = await admin.messaging().send(message);
        console.log('Notificación push enviada:', response);
      }

      // Guardar la notificación en Firestore para que se muestre en la campanita
      await admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/users/${userUID}/notifications`,
        )
        .add({
          title: 'Nueva factura generada',
          body: bodyMessage,
          invoiceId: invoiceId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false,
        });

      return null;
    } catch (error) {
      console.error('Error al procesar la notificación:', error);
      return null;
    }
  },
);

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
          let totalSaldoPendiente = 0;

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

          paymentsArray.forEach((payment) => {
            totalMontoPagado += Number(payment.amountPaid) || 0;
            totalSaldoPendiente += Number(payment.amountPending) || 0;
          });

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
          const cargos = formatCurrency(totalMontoPagado);
          const saldo = formatCurrency(totalSaldoPendiente);

          // Preparar el detalle por concepto
          const detalleConceptos = paymentsArray
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
            .join('\n');

          const accountSid = 'AC5577bf20cfdb715733d8fd1ab61505dc';
          const authToken = '0d2d04e187940f3e92798a3260476f0f';
          const messagingServiceSid = 'MG6b7af612a6554e34fce9e09a744f907b';

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
      page.drawText('Saldo Pendiente', {
        x: tableX + col1Width + col2Width + 5,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      page.drawText('Saldo a favor', {
        x: tableX + col1Width + col2Width + col3Width + 5,
        y: tableYStart + cellPadding,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      let totalMontoPagado = 0;
      let totalSaldoPendiente = 0;
      let totalSaldoAFavor = 0;
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

      // Iterar sobre cada pago individual para construir la tabla en el PDF
      for (const payment of paymentsArray) {
        totalMontoPagado += Number(payment.amountPaid) || 0;
        totalSaldoPendiente += Number(payment.amountPending) || 0;
        totalSaldoAFavor += Number(payment.creditBalance) || 0;

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
        page.drawText(formatCurrency(payment.amountPending), {
          x: tableX + col1Width + col2Width + 5,
          y: currentY + cellPadding,
          size: tableFontSize,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        page.drawText(formatCurrency(payment.creditBalance), {
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
      page.drawText(formatCurrency(totalSaldoPendiente), {
        x: tableX + col1Width + col2Width + 5,
        y: currentY + cellPadding,
        size: tableFontSizeTotals,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(formatCurrency(totalSaldoAFavor), {
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
      paymentsArray.forEach((payment) => {
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
        const saldoPendiente = formatCurrency(payment.amountPending);
        const saldoAFavor = formatCurrency(payment.creditBalance);
        paymentsDetailsHtml += `
        <tr style="border-bottom:1px solid #ddd;">
          <td style="padding:8px; text-align:left;">${concepto}</td>
          <td style="padding:8px; text-align:right;">${montoPagado}</td>
          <td style="padding:8px; text-align:right;">${saldoPendiente}</td>
          <td style="padding:8px; text-align:right;">${saldoAFavor}</td>
        </tr>
      `;
      });
      const totalsRow = `
      <tr style="font-weight:bold; border-top:2px solid #6366F1;">
        <td style="padding:8px; text-align:left;">Total:</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(totalMontoPagado)}</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(totalSaldoPendiente)}</td>
        <td style="padding:8px; text-align:right;">${formatCurrency(totalSaldoAFavor)}</td>
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
                    <th>Saldo Pendiente</th>
                    <th>Saldo a favor</th>
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

export const sendNotificationMorosidad = onRequest(
  async (req: any, res: any) => {
    return corsHandler(req, res, async () => {
      try {
        const { clientId, condominiumId, userUID } = req.body;

        // Obtener datos del usuario
        const userDoc = await admin
          .firestore()
          .doc(
            `clients/${clientId}/condominiums/${condominiumId}/users/${userUID}`,
          )
          .get();

        if (!userDoc.exists) {
          console.error('No se encontró el usuario');
          return res.status(404).send('Usuario no encontrado');
        }

        const userData = userDoc.data();

        // Obtener cargos pendientes
        const chargesSnapshot = await admin
          .firestore()
          .collection(
            `clients/${clientId}/condominiums/${condominiumId}/users/${userUID}/charges`,
          )
          .where('paid', '==', false)
          .get();

        if (chargesSnapshot.empty) {
          console.log('No hay cargos pendientes');
          return res.status(404).send('No hay cargos pendientes');
        }

        // Mapear los meses a nombres en español
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

        // Generar HTML para la tabla de cargos
        let chargesDetailsHtml = '';
        let totalAmount = 0;

        chargesSnapshot.docs.forEach((doc) => {
          const charge = doc.data();
          const startAt = charge.startAt ? charge.startAt.split(' ')[0] : ''; // Obtener solo la fecha
          const month = startAt ? new Date(startAt).getMonth() : -1;
          const monthName =
            month >= 0 ? monthNames[month] : 'Mes no especificado';
          const amount = charge.amount || 0;
          totalAmount += amount;

          chargesDetailsHtml += `
          <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:8px; text-align:left;">${charge.concept || 'Sin concepto'}</td>
            <td style="padding:8px; text-align:center;">${monthName}</td>
            <td style="padding:8px; text-align:right;">$${(amount / 100).toFixed(2)}</td>
          </tr>
        `;
        });

        const totalsRow = `
        <tr style="font-weight:bold; border-top:2px solid #6366F1;">
          <td style="padding:8px; text-align:left;">Total:</td>
          <td style="padding:8px; text-align:center;"></td>
          <td style="padding:8px; text-align:right;">$${(totalAmount / 100).toFixed(2)}</td>
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
                .totals { font-weight: bold; }
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
                  <h1>Notificación de Pagos Pendientes</h1>
                </div>
                <div class="content" style="padding:20px; background-color: #f6f6f6; margin-top:20px; border-radius: 10px;">
                  <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${userData?.name || 'Residente'}</h2>
                  <p style="color:#1a1a1a; font-size:16px;">Te notificamos que tienes los siguientes cargos pendientes:</p>
                  <table class="details-table">
                    <tr>
                      <th>Concepto</th>
                      <th>Mes</th>
                      <th>Monto</th>
                    </tr>
                    ${chargesDetailsHtml}
                    ${totalsRow}
                  </table>
                  <table style="width:100%;">
                    <tr>
                      <td>
                        <p style="font-size:12px;color:#ffffff;margin-top:20px; font-weight:bold; background-color: #6366F1;border-radius:10px;padding:20px;text-align:center">
                          Por favor, realiza tus pagos pendientes para mantener tu cuenta al corriente.
                        </p>
                      </td>
                    </tr>
                  </table>
                </div>
                <div class="footer">
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
            new Recipient(userData?.email || '', userData?.name || 'Residente'),
          ])
          .setReplyTo(
            new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
          )
          .setSubject('Notificación de Pagos Pendientes')
          .setHtml(emailHtml);

        await mailerSend.email.send(emailParams);
        console.log(`Correo enviado exitosamente a ${userData?.email}`);

        res.status(200).send('Correo enviado exitosamente');
      } catch (error) {
        console.error('Error al enviar el correo de notificación:', error);
        res.status(500).send('Error al procesar el envío de correo');
      }
    });
  },
);

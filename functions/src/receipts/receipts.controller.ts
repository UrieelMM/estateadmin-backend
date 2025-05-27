import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { defineSecret } from 'firebase-functions/params';
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

const MAILERSEND_API_KEY = defineSecret('MAILERSEND_API_KEY');

export const sendReceiptsByEmail = onRequest(
  {
    cors: true,
    region: 'us-central1',
    invoker: 'public', // Permitir acceso público a la función
    maxInstances: 10,
  },
  async (req: any, res: any) => {
    // Configurar encabezados CORS manualmente para mayor compatibilidad
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Manejar solicitudes preflight OPTIONS
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    return corsHandler(req, res, async () => {
      try {
        // Extraer parámetros del cuerpo (POST) o de la query (GET)
        const params = req.method === 'POST' ? req.body : req.query;

        const year = params.year as string;
        const month = params.month as string;
        const clientId = params.clientId as string;
        const condominiumId = params.condominiumId as string;
        const email = params.email as string; // Email del administrador que recibirá el correo
        const docType = params.docType as string;

        if (
          !year ||
          !month ||
          !clientId ||
          !condominiumId ||
          !email ||
          !docType
        ) {
          res
            .status(400)
            .send(
              'Faltan parámetros necesarios: year, month, clientId, condominiumId, email y docType.',
            );
          return;
        }

        // Formatear mes a dos dígitos y construir el campo compuesto yearMonth
        const monthString = month.padStart(2, '0');
        const yearMonth = `${year}-${monthString}`;

        console.log(
          `Buscando documentos para: yearMonth=${yearMonth}, condominiumId=${condominiumId}, clientId=${clientId}`,
        );
        console.log(
          `Se enviarán todos los comprobantes/recibos al email del administrador: ${email}`,
        );

        // Consulta en collectionGroup usando el campo compuesto
        // Nota: No filtramos por email para obtener pagos de todos los usuarios
        const snapshot = await admin
          .firestore()
          .collectionGroup('payments')
          .where('yearMonth', '==', yearMonth)
          .where('condominiumId', '==', condominiumId)
          .where('clientId', '==', clientId)
          .get();

        console.log(
          `Se encontraron ${snapshot.size} documentos en la consulta inicial`,
        );

        if (snapshot.empty) {
          res
            .status(404)
            .send('No se encontraron documentos para la fecha indicada.');
          return;
        }

        const zip = new JSZip();
        const storageBaseUrl =
          'https://storage.googleapis.com/administracioncondominio-93419.appspot.com/';

        // Recorrer todos los documentos devueltos
        let archivosAgregados = 0;

        // Conjunto para rastrear paymentGroupIds ya procesados y evitar duplicados
        const processedPaymentGroupIds = new Set<string>();
        // Conjunto para rastrear rutas de archivos ya procesados
        const processedFilePaths = new Set<string>();

        for (const doc of snapshot.docs) {
          const data = doc.data();
          console.log(`Procesando documento ${doc.id}, path: ${doc.ref.path}`);

          // Obtener información del usuario para incluirla en el nombre del archivo
          let userName = 'usuario';
          let userEmail = data.email || '';
          let userId = data.userId;

          if (userId) {
            try {
              // Intentar obtener el email y nombre del usuario asociado
              const userPath = `clients/${clientId}/condominiums/${condominiumId}/users/${userId}`;
              const userDoc = await admin.firestore().doc(userPath).get();
              if (userDoc.exists) {
                const userData = userDoc.data();
                userName = userData?.name || userData?.displayName || 'usuario';
                if (!userEmail) userEmail = userData?.email || '';
              }
            } catch (error) {
              console.error(`Error al obtener información del usuario:`, error);
            }
          }

          // Verificar si este pago pertenece a un grupo ya procesado
          const paymentGroupId = data.paymentGroupId;
          if (paymentGroupId && processedPaymentGroupIds.has(paymentGroupId)) {
            console.log(
              `Omitiendo documento ${doc.id} porque pertenece al grupo de pagos ${paymentGroupId} que ya fue procesado`,
            );
            continue;
          }

          // Si tiene paymentGroupId, marcarlo como procesado
          if (paymentGroupId) {
            processedPaymentGroupIds.add(paymentGroupId);
            console.log(
              `Marcando grupo de pagos ${paymentGroupId} como procesado`,
            );
          }

          let fileUrl;
          let fileName;

          if (docType === 'recibos') {
            // Para recibos, usar el campo receiptUrl
            if (!data.receiptUrl) {
              console.log(`Documento ${doc.id} no tiene receiptUrl`);
              continue;
            }

            fileUrl = String(data.receiptUrl);
            fileName = `recibo-${data.numberCondominium || 'sin-numero'}-${year}-${monthString}-${userName.replace(/ /g, '_')}-${doc.id}.pdf`;
            console.log(`Procesando recibo: ${fileName}`);
          } else {
            // Para comprobantes, usar el campo attachmentPayment
            if (!data.attachmentPayment) {
              console.log(`Documento ${doc.id} no tiene attachmentPayment`);
              continue;
            }

            let filePath = String(data.attachmentPayment);
            // Asegurarnos de obtener la ruta correcta sin el prefijo de la URL
            if (filePath.startsWith(storageBaseUrl)) {
              filePath = filePath.substring(storageBaseUrl.length);
            }

            // Verificar si ya procesamos este archivo (evitar duplicados por ruta)
            if (processedFilePaths.has(filePath)) {
              console.log(
                `Omitiendo archivo ${filePath} porque ya fue procesado anteriormente`,
              );
              continue;
            }

            // Marcar esta ruta de archivo como procesada
            processedFilePaths.add(filePath);

            fileName = `comprobante-${data.numberCondominium || 'sin-numero'}-${year}-${monthString}-${userName.replace(/ /g, '_')}-${doc.id}.pdf`;
            console.log(
              `Procesando comprobante: ${fileName}, ruta: ${filePath}`,
            );

            try {
              // Usar el Admin SDK para acceder al archivo
              const bucket = admin.storage().bucket();
              const file = bucket.file(filePath);

              // Verificar si el archivo existe
              const [exists] = await file.exists();
              if (!exists) {
                console.error(`El archivo ${filePath} no existe en Storage`);
                continue;
              }

              // Intentar hacer el archivo público (similar a makePaymentFilePublic)
              try {
                await file.makePublic();
                console.log(`El archivo ${filePath} ahora es público.`);
              } catch (publicError) {
                console.log(
                  `No se pudo hacer público el archivo ${filePath}, usando URL pública predeterminada:`,
                  publicError,
                );
              }

              // Usar la URL pública directa en lugar de URL firmada
              fileUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
              console.log(`URL pública generada: ${fileUrl}`);
            } catch (storageError) {
              console.error(
                `Error accediendo al archivo ${filePath}:`,
                storageError,
              );
              continue;
            }
          }

          // Descargar el archivo usando la URL
          if (fileUrl) {
            try {
              console.log(
                `Descargando archivo desde: ${fileUrl.substring(0, 50)}...`,
              );
              const response = await fetch(fileUrl);

              if (!response.ok) {
                console.error(
                  `Error al descargar el archivo para ${doc.id}: ${response.status} ${response.statusText}`,
                );
                continue;
              }

              const arrayBuffer = await response.arrayBuffer();
              if (arrayBuffer.byteLength === 0) {
                console.error(
                  `El archivo descargado para ${doc.id} está vacío`,
                );
                continue;
              }

              const fileBuffer = Buffer.from(arrayBuffer);
              console.log(
                `Archivo descargado: ${fileName}, tamaño: ${fileBuffer.length} bytes`,
              );

              // Añadir al ZIP
              zip.file(fileName, fileBuffer);
              archivosAgregados++;
            } catch (error) {
              console.error(`Error procesando el documento ${doc.id}:`, error);
            }
          }
        }

        // Verificar si se agregaron archivos al ZIP
        if (archivosAgregados === 0) {
          console.log('No se encontraron archivos para incluir en el ZIP');
          res
            .status(404)
            .send('No se encontraron archivos para enviar por correo.');
          return;
        }

        console.log(`Generando ZIP con ${archivosAgregados} archivos`);
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        console.log(`ZIP generado, tamaño: ${zipBuffer.length} bytes`);

        const htmlTemplate = (userData: any, receiptsInfo: any) => `
             <html>
               <head>
                  <style>
                     :root { font-family: 'Open Sans', sans-serif; }
                     .button {
                        background-color: #6366F1; color: white; padding: 20px; text-align: center;
                        text-decoration: none; display: inline-block; border-radius: 5px; margin-top: 20px;
                         font-size: 18px; font-weight: bold; width: 350px;
                     }
                     .footer-link { color: #6366F1 !important; text-decoration: none; }
                   </style>
                  <link rel="preconnect" href="https://fonts.googleapis.com">
                   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                  <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
               </head>
               <body style="background-color: #f6f6f6;">
                   <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto;
                       box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
                   <tr>
                    <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
                       <img style="width: 140px; height: 140px; object-fit: contain;"
                           src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521"
                           alt="EstateAdmin">
                     </td>
                   </tr>
                   <tr>
                     <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
                      <h1 style="color: white; margin: 0; font-size: 24px;">Documentos de Pago Disponibles</h1>
                     </td>
                   </tr>
                   <tr>
                       <td style="padding: 20px 0; text-align: center;">
                         <p style="font-size: 16px;">Hola ${userData.name}, adjunto encontrarás ${receiptsInfo.totalArchivos} documentos de pago correspondientes al mes ${receiptsInfo.month} del año ${receiptsInfo.year}.</p>
                         <p style="font-size: 14px;">El archivo ZIP contiene todos los documentos de los residentes del condominio.</p>
                      </td>
                   </tr>
                   <tr>
                       <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
                         <img style="width: 100px; height: 100px; object-fit: contain;"
                             src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46"
                             alt="Omnipixel">
                         <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
                       </td>
                   </tr>
                   <tr>
                       <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
                        <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
                        <p>
                            <a href="URL_FACEBOOK" class="footer-link">Facebook</a> |
                            <a href="URL_TWITTER" class="footer-link">Twitter</a> |
                            <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
                         </p>
                         <p>© Omnipixel</p>
                       </td>
                   </tr>
                   </table>
              </body>
             </html>
       `;

        const userData = {
          name: 'Administrador', // Nombre genérico para el administrador
          email: email,
        };

        const receiptsInfo = {
          year: year,
          month: monthString,
          condominiumId: condominiumId,
          totalArchivos: archivosAgregados,
        };
        const emailHtml = htmlTemplate(userData, receiptsInfo);

        const mailerSend = new MailerSend({
          apiKey: MAILERSEND_API_KEY.value(),
        });

        const emailParams = new EmailParams()
          .setFrom(
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setTo([new Recipient(userData.email, userData.name)])
          .setReplyTo(
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setSubject(`Tus documentos de pago para ${year}-${monthString}`)
          .setHtml(emailHtml)
          .setAttachments([
            {
              filename: `documentos_${year}-${monthString}.zip`,
              content: zipBuffer.toString('base64'),
            },
          ]);

        await mailerSend.email.send(emailParams);
        res.send('Correo enviado correctamente');
      } catch (error) {
        console.error('Error en sendReceiptsByEmail:', error);
        res.status(500).send('Error interno en el servidor');
      }
    });
  },
);

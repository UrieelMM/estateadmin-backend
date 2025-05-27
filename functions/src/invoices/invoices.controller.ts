import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
const { MailerSend, EmailParams, Sender, Recipient } = require('mailersend');

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
      const amount = invoiceData.amount
        ? new Intl.NumberFormat('es-MX', {
            style: 'currency',
            currency: 'MXN',
            minimumFractionDigits: 2,
          }).format(invoiceData.amount)
        : 'N/A';

      const dueDate = invoiceData.dueDate
        ? new Date(invoiceData.dueDate.seconds * 1000).toLocaleDateString(
            'es-MX',
            {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            },
          )
        : 'N/A';

      const optionalMessage = invoiceData.optionalMessage
        ? invoiceData.optionalMessage
        : 'Por favor ingresa a tus facturas para revisar los detalles. Gracias por tu preferencia.';

      // Construir el cuerpo de la notificación
      const bodyMessage = `Monto: ${amount}. Vence: ${dueDate}. ${optionalMessage}`;

      try {
        // Si existe el token, enviar la notificación push
        if (fcmToken) {
          const message = {
            notification: {
              title: 'Nueva factura generada',
              body: bodyMessage,
            },
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
      } catch (error) {
        console.error('Error al enviar notificación push:', error);
      }

      // Nuevo: Enviar correo electrónico
      try {
        // Verificar si existe un correo electrónico al que enviar
        const userEmail = invoiceData.userEmail || userData.email;
        if (!userEmail) {
          console.error('No se encontró email para enviar notificación');
          return null;
        }

        const mailerSend = new MailerSend({
          apiKey:
            process.env.MAILERSEND_API_KEY ||
            'mlsn.3611aa51c08f244faf71131ceb627e193d3f57183323b0cb39538532bd6abfa7',
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
                  <h1>Nueva Factura Generada</h1>
                </div>
                <div class="content" style="padding:20px; background-color: #f6f6f6; margin-top:20px; border-radius: 10px;">
                  <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${userData.name || 'Residente'}</h2>
                  <p style="color:#1a1a1a; font-size:16px;">Se ha generado una nueva factura para ti.</p>
                  <table class="details-table">
                    <tr>
                      <th>Detalle</th>
                      <th>Información</th>
                    </tr>
                    <tr>
                      <td style="font-weight:bold;">Monto</td>
                      <td>${amount}</td>
                    </tr>
                    <tr>
                      <td style="font-weight:bold;">Fecha de Vencimiento</td>
                      <td>${dueDate}</td>
                    </tr>
                    <tr>
                      <td style="font-weight:bold;">Folio de la factura</td>
                      <td>${invoiceData.invoiceNumber || invoiceId}</td>
                    </tr>
                    ${
                      invoiceData.concept
                        ? `
                    <tr>
                      <td style="font-weight:bold;">Concepto</td>
                      <td>${invoiceData.concept}</td>
                    </tr>
                    `
                        : ''
                    }
                  </table>
                  <table style="width:100%;">
                    <tr>
                      <td>
                        <p style="font-size:12px;color:#ffffff;margin-top:20px; font-weight:bold; background-color: #6366F1;border-radius:10px;padding:20px;text-align:center">
                          ${optionalMessage}
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
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setTo([new Recipient(userEmail, userData.name || 'Residente')])
          .setReplyTo(
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setSubject(`Nueva Factura - Vence: ${dueDate}`)
          .setHtml(emailHtml);

        await mailerSend.email.send(emailParams);
        console.log(`Correo de factura enviado exitosamente a ${userEmail}`);
      } catch (emailError) {
        console.error('Error al enviar correo electrónico:', emailError);
      }

      return null;
    } catch (error) {
      console.error('Error al procesar la notificación:', error);
      return null;
    }
  },
);

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
const { MailerSend, EmailParams, Sender, Recipient } = require('mailersend');

export const onContactFormSubmitted = onDocumentCreated(
  {
    document: 'administration/users/emailsToContact/{contactId}',
  },
  async (event: any) => {
    const snap = event.data;
    const contactData = snap.data();

    if (!contactData) {
      console.error('No se encontraron datos del formulario de contacto');
      return null;
    }

    try {
      // Extraer los datos del formulario de contacto
      const { name, email, phone, message, createdAt } = contactData;

      // Formatear la fecha si existe
      let formattedDate = 'No disponible';
      if (createdAt) {
        const date = createdAt.toDate();
        formattedDate = new Intl.DateTimeFormat('es-MX', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Mexico_City',
        }).format(date);
      }

      // Crear el HTML del correo electrónico
      const emailHtml = `
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { font-family: 'Open Sans', sans-serif; margin:0; padding:0; background-color: #f6f6f6; }
              .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
              .header { background-color: #6366F1; padding: 20px; text-align: center; color: white; }
              .header img { width: 150px; margin-bottom: 10px; }
              .header h1 { margin: 0; font-size: 24px; }
              .content { padding: 30px 20px; }
              .info-block { margin-bottom: 25px; }
              .info-label { font-weight: bold; color: #6366F1; margin-bottom: 5px; }
              .info-value { margin: 0; padding: 8px; background-color: #f9fafb; border-radius: 4px; border-left: 3px solid #6366F1; }
              .message-block { margin-top: 30px; }
              .message-label { font-weight: bold; color: #6366F1; margin-bottom: 5px; }
              .message-content { margin: 0; padding: 15px; background-color: #f9fafb; border-radius: 4px; border-left: 3px solid #6366F1; white-space: pre-line; }
              .footer { background-color: #f9fafb; padding: 15px; text-align: center; font-size: 12px; color: #6b7280; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
                <h1>Nuevo Formulario de Contacto</h1>
              </div>
              <div class="content">
                <p>Se ha recibido un nuevo mensaje a través del formulario de contacto:</p>
                
                <div class="info-block">
                  <div class="info-label">Nombre:</div>
                  <p class="info-value">${name || 'No proporcionado'}</p>
                </div>
                
                <div class="info-block">
                  <div class="info-label">Correo Electrónico:</div>
                  <p class="info-value">${email || 'No proporcionado'}</p>
                </div>
                
                <div class="info-block">
                  <div class="info-label">Teléfono:</div>
                  <p class="info-value">${phone || 'No proporcionado'}</p>
                </div>
                
                <div class="info-block">
                  <div class="info-label">Fecha de Envío:</div>
                  <p class="info-value">${formattedDate}</p>
                </div>
                
                <div class="message-block">
                  <div class="message-label">Mensaje:</div>
                  <p class="message-content">${message || 'No se proporcionó ningún mensaje'}</p>
                </div>
              </div>
              <div class="footer">
                <p>Este es un correo automático, por favor no responda a este mensaje.</p>
                <p>&copy; ${new Date().getFullYear()} EstateAdmin. Todos los derechos reservados.</p>
              </div>
            </div>
          </body>
        </html>
      `;

      // Configurar y enviar el correo electrónico
      const mailerSend = new MailerSend({
        apiKey:
          process.env.MAILERSEND_API_KEY ||
          'mlsn.3611aa51c08f244faf71131ceb627e193d3f57183323b0cb39538532bd6abfa7',
      });

      const emailParams = new EmailParams()
        .setFrom(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setTo([new Recipient('urieel.mm@gmail.com', 'EstateAdmin Admin')])
        .setReplyTo(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setSubject(`Nuevo Formulario de Contacto de ${name}`)
        .setHtml(emailHtml);

      await mailerSend.email.send(emailParams);
      console.log(
        `Correo de formulario de contacto enviado exitosamente a urieel.mm@gmail.com`,
      );

      return null;
    } catch (error) {
      console.error('Error al procesar el formulario de contacto:', error);
      return null;
    }
  },
);

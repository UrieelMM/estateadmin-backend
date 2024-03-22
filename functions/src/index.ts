const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { MailerSend, EmailParams, Recipient, Sender } = require('mailersend');

admin.initializeApp();

exports.enviarEmailPorPublicacion = functions.firestore
  .document('clients/{clientId}/condominiums/{condominiumId}/publications/{publicationId}')
  .onCreate(async (snapshot: { data: () => any; }, context: { params: { clientId: any; condominiumId: any; }; }) => {
    const publicationData = snapshot.data();
    const { clientId, condominiumId } = context.params;

    const mailerSend = new MailerSend({
      apiKey: 'mlsn.0f4dcc57b72525ca512f29f8825a3a654aedb9cb10827df3e2934e8d67440e38',
    });

    const usersRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
    const emailPromises: any[] = [];

    try {
      const usersSnapshot = await usersRef.get();

      usersSnapshot.docs.forEach((userDoc: { data: () => any; }) => {
        const userData = userDoc.data();

        // Determinar si el correo debe enviarse al usuario
        let shouldSendEmail = false;
        if (publicationData.sendTo === 'todos') {
          shouldSendEmail = true;
        } else if (Array.isArray(publicationData.sendTo)) {
          const fullName = `${userData.name} ${userData.lastName}`;
          shouldSendEmail = publicationData.sendTo.includes(fullName);
        } else {
          shouldSendEmail = publicationData.sendTo === userData.role;
        }

        if (userData.email && shouldSendEmail) {
          const htmlTemplate = (
            userData: any,
            publicationData: { title: any; content: any, condominiumName: any;},
            attachmentUrls: any[],
          ) => `
          <html>
          <head>
            <style>
              :root {
                font-family: 'Open Sans', sans-serif;
              }
              .button {
                background-color: #6366F1; 
                color: white; 
                padding: 20px; 
                text-align: center; 
                text-decoration: none; 
                display: inline-block; 
                border-radius: 5px;
                margin-top: 20px;
                color: #ffffff !important;
                font-size: 18px;
                font-weight: bold;
                width: 350px;
              }
              .footer-link {
                color: #6366F1 !important;
                text-decoration: none;
              }
            </style>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
          </head>
          <body style="background-color: #f6f6f6;">
            <table width="50%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
            <tr>
              <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
                <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
            </td>
            </tr>
            <tr>
              <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 24px;">Hay una nueva publicación</h1>
              </td>
            </tr>
              <tr>
                <td style="padding: 20px 0; text-align: center;">
                  <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
                    <tr>
                      <td style=" border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
                        <h2 style="color: #6366F1; font-size: 20px;">Hola, ${userData.name} Tu comunidad ${publicationData.condominiumName} ha emitido una nueva publicación</h2>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 10px 0; font-size: 22px; font-weight: bold; font-size: 18px;" width="200">${publicationData.title}</td>
                    </tr>
                    <tr>
                      <td style="padding: 10px 0; font-size: 20px; font-size: 16px;">${publicationData.content}</td>
                    </tr>
                    <tr>
                      <td style="text-align: center;">
                        <a href="https://www.urieel.dev" class="button">Ir a mi cuenta</a>
                      </td>
                    </tr>
                    ${attachmentUrls && attachmentUrls.length > 0
              ? `<tr>
                            <td style="text-align: center; padding-top: 20px;">
                              <h4 style="font-weight: bold">Archivos adjuntos:</h4>
                              ${attachmentUrls.map((url, index) => `<p><a href="${url}" style="color: #6366F1; font-size: 16px; margin: 10px 0;">Archivo Adjunto ${index + 1}</a></p>`).join("")}
                            </td>
                          </tr>`
              : ""
            }
                  </table>
                </td>
              </tr>
              <tr>
                <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
                  <img style="width: 100px; height: 100px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46" alt="Omnipixel">
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
          let emailHtml = htmlTemplate(
            userData,
            publicationData,
            publicationData.attachmentPublications,
          );

          const emailParams = new EmailParams()
            .setFrom(
              new Sender(
                'estateadmin@urieel.dev',
                'EstateAdmin Support',
              ),
            )
            .setTo([new Recipient(userData.email, userData.name || '')])
            .setReplyTo(
              new Sender(
                'estateadmin@urieel.dev',
                'EstateAdmin Support',
              ),
            )
            .setSubject(`Nueva publicación en ${publicationData.condominiumName}: ${publicationData.title}`)
            .setHtml(emailHtml);

          emailPromises.push(mailerSend.email.send(emailParams));
        }
      });

      await Promise.all(emailPromises);
      console.log(`Correos enviados exitosamente a los usuarios del condominio ${condominiumId}`);
    } catch (error) {
      console.error(`Error al enviar correos electrónicos al condominio ${condominiumId}:`, error);
    }
  });

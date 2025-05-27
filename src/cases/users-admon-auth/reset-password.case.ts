import * as admin from 'firebase-admin';
import { ResetPasswordDto } from '../../dtos/reset-password.dto';
import { InternalServerErrorException } from '@nestjs/common';
import { EmailParams, Sender, Recipient } from 'mailersend';
import { mailerSend } from 'src/utils/mailerSend';

export const resetPassword = async (resetPasswordDto: ResetPasswordDto) => {
  const { email } = resetPasswordDto;

  try {
    // Configuración para el correo de recuperación
    const actionCodeSettings = {
      url: 'https://administracioncondominio-93419.firebaseapp.com/__/auth/action',
      handleCodeInApp: true,
    };

    // Generar el link de recuperación
    const link = await admin
      .auth()
      .generatePasswordResetLink(email, actionCodeSettings);
    console.log('Link generado:', link);

    // Configurar el correo
    const sentFrom = new Sender(
      'MS_Fpa0aS@notifications.estate-admin.com',
      'EstateAdmin Notifications',
    );
    const recipients = [new Recipient(email)];

    // Plantilla HTML del correo
    const htmlTemplate = `
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
                <h1 style="color: white; margin: 0; font-size: 24px;">Recupera tu contraseña</h1>
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 0; text-align: center;">
                <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
                  <tr>
                    <td style="border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
                      <h2 style="color: #6366F1; font-size: 20px;">Hola, ${email}</h2>
                      <p style="font-size: 16px;">Has solicitado restablecer tu contraseña. Haz clic en el botón de abajo para continuar con el proceso.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 20px 0; text-align: center;">
                      <a href="${link}" class="button">Restablecer Contraseña</a>
                    </td>
                  </tr>
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

    const emailParams = new EmailParams()
      .setFrom(sentFrom)
      .setTo(recipients)
      .setReplyTo(
        new Sender(
          'MS_Fpa0aS@notifications.estate-admin.com',
          'EstateAdmin Notifications',
        ),
      )
      .setSubject('Recupera tu contraseña - EstateAdmin')
      .setHtml(htmlTemplate);

    // Enviar el correo
    await mailerSend.email.send(emailParams);

    return {
      status: true,
      code: 200,
      message:
        'Se ha enviado un correo con las instrucciones para restablecer tu contraseña.',
    };
  } catch (error: any) {
    console.error('Error detallado:', {
      code: error.code,
      message: error.message,
      stack: error.stack,
    });

    if (error.code === 'auth/user-not-found') {
      throw new InternalServerErrorException(
        'No se encontró un usuario con ese correo electrónico.',
      );
    }

    throw new InternalServerErrorException(
      'Error al procesar la solicitud de recuperación de contraseña.',
    );
  }
};

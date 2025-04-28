import { MailerSend, EmailParams, Recipient, Sender } from 'mailersend';
import * as admin from 'firebase-admin';

export class ParcelReceptionService {
  private mailerSend: any;

  constructor() {
    this.mailerSend = new MailerSend({
      apiKey:
        process.env.MAILERSEND_API_KEY ||
        'mlsn.0cda1e684fe67e14b7b569d23fc3d66bcb1950417ef2eb9f18007246c6e5a57a',
    });
  }

  /**
   * Verifica si el usuario desea recibir notificaciones por email
   * @param clientId ID del cliente
   * @param condominiumId ID del condominio
   * @param email Email del usuario para buscar
   * @returns Objeto con las preferencias de notificación y datos del usuario
   */
  async checkUserNotificationPreference(
    clientId: string,
    condominiumId: string,
    email: string,
  ): Promise<{
    wantsEmailNotifications: boolean;
    userData: any | null;
  }> {
    try {
      // Buscamos por email
      const usersRef = admin
        .firestore()
        .collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
      const querySnapshot = await usersRef
        .where('email', '==', email)
        .limit(1)
        .get();

      if (!querySnapshot.empty) {
        const userDoc = querySnapshot.docs[0];
        const userData = userDoc.data();

        // Verificar si el usuario quiere recibir notificaciones por email
        const wantsEmailNotifications = userData?.notifications?.email === true;

        return { wantsEmailNotifications, userData };
      }

      return {
        wantsEmailNotifications: false,
        userData: null,
      };
    } catch (error) {
      console.error('Error al verificar preferencias de notificación:', error);
      // Por defecto, asumimos que no quiere notificaciones en caso de error
      return {
        wantsEmailNotifications: false,
        userData: null,
      };
    }
  }

  /**
   * Genera la plantilla HTML para el correo de notificación de paquete recibido
   * @param userData Datos del usuario
   * @param parcelData Datos del paquete
   * @returns Plantilla HTML del correo
   */
  private generateParcelEmailTemplate(userData: any, parcelData: any): string {
    return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');
          
          body { 
            font-family: 'Poppins', sans-serif; 
            margin: 0; 
            padding: 0; 
            background-color: #f5f7fa; 
            line-height: 1.6;
          }
          
          .container { 
            max-width: 600px; 
            margin: 40px auto; 
            background-color: #ffffff; 
            border-radius: 16px; 
            overflow: hidden;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
          }
          
          .header { 
            background-color: #6366F1; 
            padding: 30px 20px; 
            text-align: center; 
          }
          
          .header img { 
            width: 120px; 
            height: auto; 
            margin-bottom: 15px;
          }
          
          .header h1 { 
            color: white; 
            margin: 0; 
            font-size: 24px; 
            font-weight: 600;
            letter-spacing: 0.5px;
          }
          
          .content { 
            padding: 40px 30px; 
            background-color: #ffffff;
          }
          
          .greeting {
            font-size: 22px;
            font-weight: 600;
            color: #2d3748;
            margin-bottom: 15px;
          }
          
          .message {
            font-size: 16px;
            color: #4a5568;
            margin-bottom: 30px;
          }
          
          .parcel-card {
            background-color: #f8fafc;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 30px;
            border-left: 4px solid #6366F1;
          }
          
          .parcel-icon {
            text-align: center;
            font-size: 48px;
            margin-bottom: 15px;
          }
          
          .parcel-title {
            font-size: 18px;
            font-weight: 600;
            color: #2d3748;
            margin-bottom: 20px;
            text-align: center;
          }
          
          .parcel-detail {
            display: flex;
            margin-bottom: 15px;
            align-items: flex-start;
          }
          
          .detail-icon {
            flex: 0 0 24px;
            color: #6366F1;
            margin-right: 12px;
            font-weight: bold;
          }
          
          .detail-label {
            flex: 0 0 120px;
            font-weight: 500;
            color: #4a5568;
          }
          
          .detail-value {
            flex: 1;
            color: #1a202c;
          }
          
          .note-box {
            background-color: #6366F1;
            color: white;
            padding: 16px 20px;
            border-radius: 8px;
            font-weight: 500;
            text-align: center;
            margin-top: 30px;
          }
          
          .action-button {
            display: block;
            text-align: center;
            background-color: #6366F1;
            color: white;
            text-decoration: none;
            padding: 15px 20px;
            border-radius: 8px;
            font-weight: 600;
            margin: 25px auto;
            max-width: 200px;
            transition: all 0.3s ease;
          }
          
          .action-button:hover {
            background-color: #4F46E5;
          }
          
          .footer {
            background-color: #f6f6f6;
            border-radius: 0 0 10px 10px;
            padding: 25px 20px;
            text-align: center;
            font-size: 14px;
            color: #1a1a1a;
          }
          
          .social-links a {
            color: #6366F1 !important;
            text-decoration: none;
            margin: 0 10px;
          }
          
          .company {
            font-weight: bold;
            margin-top: 10px;
          }
          
          @media (max-width: 600px) {
            .content {
              padding: 30px 20px;
            }
            
            .parcel-card {
              padding: 20px 15px;
            }
            
            .detail-label {
              flex: 0 0 100px;
            }
          }
        </style>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
      </head>
      <body>
        <div class="container">
          <div class="header">
            <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
            <h1>Tu paquete te espera</h1>
          </div>
          
          <div class="content">
            <div class="greeting">Hola, ${userData.name || 'Residente'}</div>
            <div class="message">Tienes un paquete esperando a ser recogido en la recepción.</div>
            
            <div class="parcel-card">
              <div class="parcel-icon">📦</div>
              <div class="parcel-title">Información del paquete</div>
              
              <div class="parcel-detail">
                <div class="detail-icon">📅</div>
                <div class="detail-label">Recibido:</div>
                <div class="detail-value">${parcelData.dateReception || 'No especificado'} ${parcelData.hourReception || ''}</div>
              </div>
              
              <div class="parcel-detail">
                <div class="detail-icon">🚚</div>
                <div class="detail-label">Mensajería:</div>
                <div class="detail-value">${parcelData.courier || 'No especificado'}</div>
              </div>
              
              ${
                parcelData.trackingNumber
                  ? `
              <div class="parcel-detail">
                <div class="detail-icon">🔍</div>
                <div class="detail-label">Seguimiento:</div>
                <div class="detail-value">${parcelData.trackingNumber}</div>
              </div>
              `
                  : ''
              }
              
              ${
                parcelData.description
                  ? `
              <div class="parcel-detail">
                <div class="detail-icon">📝</div>
                <div class="detail-label">Descripción:</div>
                <div class="detail-value">${parcelData.description}</div>
              </div>
              `
                  : ''
              }
            </div>
            
            <div class="note-box">
              Recuerda presentar una identificación oficial para poder recoger tu paquete
            </div>
            
            <a href="#" class="action-button">Ir a la App</a>
          </div>
          
          <div class="footer">
            <div>Modernidad y Eficacia en la Administración</div>
            <div class="social-links">
              <a href="URL_FACEBOOK">Facebook</a> | 
              <a href="URL_TWITTER">Twitter</a> | 
              <a href="URL_INSTAGRAM">Instagram</a>
            </div>
            <div class="company">Omnipixel</div>
          </div>
        </div>
      </body>
    </html>
    `;
  }

  /**
   * Envía un correo electrónico de notificación de paquete recibido
   * @param email Correo electrónico del destinatario
   * @param userData Datos del usuario
   * @param parcelData Datos del paquete
   * @returns Resultado del envío
   */
  async sendEmailNotification(
    email: string,
    userData: any,
    parcelData: any,
  ): Promise<any> {
    try {
      // Generar la plantilla HTML del correo
      const emailHtml = this.generateParcelEmailTemplate(userData, parcelData);

      // Configurar los parámetros del correo
      const emailParams = new EmailParams()
        .setFrom(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
        )
        .setTo([new Recipient(email, userData.name || '')])
        .setReplyTo(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
        )
        .setSubject(`¡Tienes un nuevo paquete en la recepción!`)
        .setHtml(emailHtml);

      // Enviar el correo
      await this.mailerSend.email.send(emailParams);
      console.log(`Correo enviado exitosamente a ${email}`);
      return true;
    } catch (error) {
      console.error('Error al enviar el correo:', error);
      return false;
    }
  }
}

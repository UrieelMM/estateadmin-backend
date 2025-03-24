import * as admin from 'firebase-admin';
import { ConfirmResetPasswordDto } from '../../dtos/confirm-reset-password.dto';
import { InternalServerErrorException } from '@nestjs/common';

export const confirmResetPassword = async (confirmResetPasswordDto: ConfirmResetPasswordDto) => {
  const { oobCode, newPassword } = confirmResetPasswordDto;

  try {
    // Verificar y aplicar el código de restablecimiento
    await (admin.auth() as any).verifyPasswordResetCode(oobCode);
    
    // Actualizar la contraseña
    await (admin.auth() as any).confirmPasswordReset(oobCode, newPassword);

    return { message: 'Contraseña actualizada exitosamente.' };
  } catch (error) {
    console.error('Error al confirmar el restablecimiento de contraseña', error);
    throw new InternalServerErrorException('Error al confirmar el restablecimiento de contraseña.');
  }
}; 
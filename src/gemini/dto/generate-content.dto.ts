import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class GenerateContentDto {
  @ApiProperty({
    description: 'The text prompt to send to the Gemini API',
    example: 'Write a short story about a space explorer.',
  })
  @IsString()
  @IsNotEmpty()
  prompt: string;
}

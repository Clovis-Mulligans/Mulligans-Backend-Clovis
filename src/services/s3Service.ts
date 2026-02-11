// src/services/s3Service.ts
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = 'mulligans-golf-images-mvp';

// CloudFront CDN domain - falls back to direct S3 URL if not set
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;

function buildImageUrl(key: string): string {
  if (CLOUDFRONT_DOMAIN) {
    return `https://${CLOUDFRONT_DOMAIN}/${key}`;
  }
  return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'eu-west-2'}.amazonaws.com/${key}`;
}

export interface UploadResult {
  url: string;
  key: string;
}

export class S3Service {
  static async uploadImage(
    file: Buffer,
    mimetype: string,
    originalName: string
  ): Promise<UploadResult> {
    const fileExtension = originalName.split('.').pop();
    const key = `listings/${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file,
      ContentType: mimetype,
    });

    await s3Client.send(command);

    const url = buildImageUrl(key);

    return { url, key };
  }

  // Upload support ticket images to separate folder
  static async uploadSupportImage(
    file: Buffer,
    mimetype: string,
    originalName: string,
    ticketId: string
  ): Promise<UploadResult> {
    const fileExtension = originalName.split('.').pop();
    const key = `support/${ticketId}/${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file,
      ContentType: mimetype,
    });

    await s3Client.send(command);

    const url = buildImageUrl(key);

    return { url, key };
  }

  static async deleteImage(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);
  }

  static async deleteImages(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.deleteImage(key)));
  }
}
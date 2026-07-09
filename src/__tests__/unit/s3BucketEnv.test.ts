jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));

import { S3Client } from '@aws-sdk/client-s3';
import { S3Service } from '../../services/s3Service';

const sendMock = jest.fn().mockResolvedValue({});
jest.spyOn(S3Client.prototype, 'send').mockImplementation(sendMock);

describe('S3Service bucket resolution', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = { ...savedEnv };
    sendMock.mockClear();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe('uploadImage', () => {
    it('uses S3_BUCKET_NAME when set', async () => {
      process.env.S3_BUCKET_NAME = 'mulligans-golf-images-dev';

      await S3Service.uploadImage(Buffer.from('x'), 'image/png', 'test.png');

      const input = sendMock.mock.calls[0][0].input;
      expect(input.Bucket).toBe('mulligans-golf-images-dev');
    });

    it('falls back to mulligans-golf-images-mvp when S3_BUCKET_NAME is unset', async () => {
      delete process.env.S3_BUCKET_NAME;

      await S3Service.uploadImage(Buffer.from('x'), 'image/png', 'test.png');

      const input = sendMock.mock.calls[0][0].input;
      expect(input.Bucket).toBe('mulligans-golf-images-mvp');
    });
  });

  describe('uploadSupportImage', () => {
    it('uses the resolved bucket name', async () => {
      process.env.S3_BUCKET_NAME = 'mulligans-golf-images-dev';

      await S3Service.uploadSupportImage(
        Buffer.from('x'), 'image/png', 'test.png', 'ticket-123'
      );

      const input = sendMock.mock.calls[0][0].input;
      expect(input.Bucket).toBe('mulligans-golf-images-dev');
    });
  });

  describe('deleteImage', () => {
    it('uses the resolved bucket name', async () => {
      process.env.S3_BUCKET_NAME = 'mulligans-golf-images-dev';

      await S3Service.deleteImage('listings/abc.png');

      const input = sendMock.mock.calls[0][0].input;
      expect(input.Bucket).toBe('mulligans-golf-images-dev');
    });
  });
});

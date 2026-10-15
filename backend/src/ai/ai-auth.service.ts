import { Injectable } from '@nestjs/common';
import { GoogleAuth, IdTokenClient } from 'google-auth-library';

@Injectable()
export class AiAuthService {
  private googleAuth: GoogleAuth | undefined;
  private tokenClient: IdTokenClient | undefined;
  private tokenAudience: string | undefined;

  async getIdTokenHeaders(audience: string): Promise<Record<string, string>> {
    if (this.tokenClient && this.tokenAudience !== audience) {
      this.tokenClient = undefined;
    }
    if (!this.tokenClient) {
      this.googleAuth ??= new GoogleAuth();
      this.tokenClient = await this.googleAuth.getIdTokenClient(audience);
      this.tokenAudience = audience;
    }

    const headers = await this.tokenClient.getRequestHeaders();
    return Object.fromEntries(headers.entries());
  }
}

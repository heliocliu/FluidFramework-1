/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/common-utils";
import * as api from "@fluidframework/driver-definitions";
import { IClient, IErrorTrackingService } from "@fluidframework/protocol-definitions";
import { GitManager, Historian, ICredentials, IGitCache } from "@fluidframework/server-services-client";
import io from "socket.io-client";
import { ITelemetryLogger } from "@fluidframework/common-definitions";
import { DeltaStorageService, DocumentDeltaStorageService } from "./deltaStorageService";
import { DocumentStorageService } from "./documentStorageService";
import { R11sDocumentDeltaConnection } from "./documentDeltaConnection";
import { NullBlobStorageService } from "./nullBlobStorageService";
import { ITokenProvider } from "./tokens";
import { RouterliciousStorageRestWrapper } from "./restWrapper";

/**
 * The DocumentService manages the Socket.IO connection and manages routing requests to connected
 * clients
 */
export class DocumentService implements api.IDocumentService {
    constructor(
        public readonly resolvedUrl: api.IResolvedUrl,
        protected ordererUrl: string,
        private readonly deltaStorageUrl: string,
        private readonly gitUrl: string,
        private readonly errorTracking: IErrorTrackingService,
        private readonly disableCache: boolean,
        private readonly historianApi: boolean,
        private readonly directCredentials: ICredentials | undefined,
        private readonly gitCache: IGitCache | undefined,
        private readonly logger: ITelemetryLogger,
        protected tokenProvider: ITokenProvider,
        protected tenantId: string,
        protected documentId: string,
    ) {
    }

    private documentStorageService: DocumentStorageService | undefined;

    /**
     * Connects to a storage endpoint for snapshot service.
     *
     * @returns returns the document storage service for routerlicious driver.
     */
    public async connectToStorage(): Promise<api.IDocumentStorageService> {
        if (this.gitUrl === undefined) {
            return new NullBlobStorageService();
        }

        const storageRestWrapper = await RouterliciousStorageRestWrapper.load(
            this.tenantId,
            this.documentId,
            this.tokenProvider,
            this.logger,
            this.gitUrl,
            this.directCredentials,
        );
        const historian = new Historian(
            this.gitUrl,
            this.historianApi,
            this.disableCache,
            storageRestWrapper);
        const gitManager = new GitManager(historian);

        // Insert cached seed data
        if (this.gitCache !== undefined) {
            for (const ref of Object.keys(this.gitCache.refs)) {
                gitManager.addRef(ref, this.gitCache.refs[ref]);
            }

            for (const commit of this.gitCache.commits) {
                gitManager.addCommit(commit);
            }

            for (const tree of this.gitCache.trees) {
                gitManager.addTree(tree);
            }

            for (const blob of this.gitCache.blobs) {
                gitManager.addBlob(blob);
            }
        }

        this.documentStorageService = new DocumentStorageService(this.documentId, gitManager, this.logger);
        return this.documentStorageService;
    }

    /**
     * Connects to a delta storage endpoint for getting ops between a range.
     *
     * @returns returns the document delta storage service for routerlicious driver.
     */
    public async connectToDeltaStorage(): Promise<api.IDocumentDeltaStorageService> {
        assert(!!this.documentStorageService, 0x0b1 /* "Storage service not initialized" */);

        const deltaStorage = new DeltaStorageService(this.deltaStorageUrl, this.tokenProvider, this.logger);
        return new DocumentDeltaStorageService(this.tenantId, this.documentId,
            deltaStorage, this.documentStorageService);
    }

    /**
     * Connects to a delta stream endpoint for emitting ops.
     *
     * @returns returns the document delta stream service for routerlicious driver.
     */
    public async connectToDeltaStream(client: IClient): Promise<api.IDocumentDeltaConnection> {
        const connect = async () => {
            const ordererToken = await this.tokenProvider.fetchOrdererToken(
                this.tenantId,
                this.documentId,
            );
            return R11sDocumentDeltaConnection.create(
                this.tenantId,
                this.documentId,
                ordererToken.jwt,
                io,
                client,
                this.ordererUrl,
                this.logger,
            );
        };

        // Attempt to establish connection.
        // Retry with new token on authorization error; otherwise, allow container layer to handle.
        try {
            const connection = await connect();
            return connection;
        } catch (error) {
            if (error?.statusCode === 401) {
                // Fetch new token and retry once,
                // otherwise 401 will be bubbled up as non-retriable AuthorizationError.
                return connect();
            }
            throw error;
        }
    }

    public getErrorTrackingService() {
        return this.errorTracking;
    }
}

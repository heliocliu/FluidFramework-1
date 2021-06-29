/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IMember, IServiceAudience } from "@fluid-experimental/fluid-framework";
import { ITelemetryBaseLogger } from "@fluidframework/common-definitions";
import { ITokenProvider } from "@fluidframework/routerlicious-driver";

export interface FrsContainerConfig {
    id: string;
    logger?: ITelemetryBaseLogger;
}

interface FrsConnectionConfigBase {
    tenantId: string;
    orderer: string;
    storage: string;
    user?: FrsMember;
}

interface FrsConnectionConfigWithKey extends FrsConnectionConfigBase {
    type: "key";
    key: string;
}

interface FrsConnectionConfigWithTokenProvider extends FrsConnectionConfigBase {
    type: "tokenProvider";
    tokenProvider: ITokenProvider
}

export type FrsConnectionConfig = FrsConnectionConfigWithKey | FrsConnectionConfigWithTokenProvider;

/**
 * FrsContainerServices is returned by the FrsClient alongside a FluidContainer.
 * It holds the functionality specifically tied to the Frs service, and how the data stored in
 * the FluidContainer is persisted in the backend and consumed by users. Any functionality regarding
 * how the data is handled within the FluidContainer itself, i.e. which data objects or DDSes to use,
 * will not be included here but rather on the FluidContainer class itself.
 */
export interface FrsContainerServices {
    /**
     * Provides an object that can be used to get the users that are present in this Fluid session and
     * listeners for when the roster has any changes from users joining/leaving the session
     */
    audience: IFrsAudience;
}

/**
 * Since Frs provides user names for all of its members, we extend the IMember interface to include
 * this service-specific value. It will be returned for all audience members connected to Frs.
 */
export interface FrsMember extends IMember {
    userName: string;
}

export type IFrsAudience = IServiceAudience<FrsMember>;
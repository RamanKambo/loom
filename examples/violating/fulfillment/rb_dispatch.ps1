<#
.SYNOPSIS
Dispatches a paid order to fulfillment by creating a pending shipment.

.DESCRIPTION
Test fixture for the generated Routines.Contract.Tests.ps1 that VIOLATES the
sample contract of routine fulfillment.rb_dispatch: OrderId is not Mandatory.
The routine takes named parameters, so its declaration order carries no
meaning. The generated tests must fail on it.
#>
[CmdletBinding()]
param(
    [string] $OrderId,

    [switch] $Notify,

    [Parameter()]
    [ValidateSet('pending', 'dispatched', 'delivered')]
    [string] $InitialState = 'pending'
)

[pscustomobject]@{
    shipment_id = [guid]::NewGuid().ToString()
    state       = $InitialState
}

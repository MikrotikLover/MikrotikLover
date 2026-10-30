#!/usr/bin/env python3
"""OVF 1.0 description for the .ova (VMware Workstation / ESXi, VirtualBox): 2 CPUs, 4 GB, one LSI Logic SCSI disk,
one E1000 network card on a bridged network.      ovf.py NAME DISK.vmdk VIRTUAL-SIZE-BYTES > NAME.ovf"""
import os
import sys
from xml.sax.saxutils import escape


def ovf(name, vmdk, capacity):
    n, v = escape(name), escape(os.path.basename(vmdk))
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<Envelope vmw:buildId="build-0" xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:cim="http://schemas.dmtf.org/wbem/wscim/1/common"
  xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1" xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData"
  xmlns:vmw="http://www.vmware.com/schema/ovf" xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <References>
    <File ovf:href="{v}" ovf:id="file1" ovf:size="{os.path.getsize(vmdk)}"/>
  </References>
  <DiskSection>
    <Info>Virtual disk information</Info>
    <Disk ovf:capacity="{capacity}" ovf:capacityAllocationUnits="byte" ovf:diskId="vmdisk1" ovf:fileRef="file1"
      ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/>
  </DiskSection>
  <NetworkSection>
    <Info>The list of logical networks</Info>
    <Network ovf:name="bridged">
      <Description>The LAN with the MikroTik routers (bridged)</Description>
    </Network>
  </NetworkSection>
  <VirtualSystem ovf:id="{n}">
    <Info>MikrotikLover RADIUS server</Info>
    <Name>{n}</Name>
    <OperatingSystemSection ovf:id="94" vmw:osType="ubuntu64Guest">
      <Info>The kind of installed guest operating system</Info>
      <Description>Ubuntu 24.04 LTS (64-bit)</Description>
    </OperatingSystemSection>
    <VirtualHardwareSection>
      <Info>Virtual hardware requirements</Info>
      <System>
        <vssd:ElementName>Virtual Hardware Family</vssd:ElementName>
        <vssd:InstanceID>0</vssd:InstanceID>
        <vssd:VirtualSystemIdentifier>{n}</vssd:VirtualSystemIdentifier>
        <vssd:VirtualSystemType>vmx-13 virtualbox-2.2</vssd:VirtualSystemType>
      </System>
      <Item>
        <rasd:AllocationUnits>hertz * 10^6</rasd:AllocationUnits>
        <rasd:Description>Number of Virtual CPUs</rasd:Description>
        <rasd:ElementName>2 virtual CPU(s)</rasd:ElementName>
        <rasd:InstanceID>1</rasd:InstanceID>
        <rasd:ResourceType>3</rasd:ResourceType>
        <rasd:VirtualQuantity>2</rasd:VirtualQuantity>
      </Item>
      <Item>
        <rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits>
        <rasd:Description>Memory Size</rasd:Description>
        <rasd:ElementName>4096MB of memory</rasd:ElementName>
        <rasd:InstanceID>2</rasd:InstanceID>
        <rasd:ResourceType>4</rasd:ResourceType>
        <rasd:VirtualQuantity>4096</rasd:VirtualQuantity>
      </Item>
      <Item>
        <rasd:Address>0</rasd:Address>
        <rasd:Description>SCSI Controller</rasd:Description>
        <rasd:ElementName>SCSI Controller 0</rasd:ElementName>
        <rasd:InstanceID>3</rasd:InstanceID>
        <rasd:ResourceSubType>lsilogic</rasd:ResourceSubType>
        <rasd:ResourceType>6</rasd:ResourceType>
      </Item>
      <Item>
        <rasd:AddressOnParent>0</rasd:AddressOnParent>
        <rasd:ElementName>Hard Disk 1</rasd:ElementName>
        <rasd:HostResource>ovf:/disk/vmdisk1</rasd:HostResource>
        <rasd:InstanceID>4</rasd:InstanceID>
        <rasd:Parent>3</rasd:Parent>
        <rasd:ResourceType>17</rasd:ResourceType>
      </Item>
      <Item>
        <rasd:AddressOnParent>7</rasd:AddressOnParent>
        <rasd:AutomaticAllocation>true</rasd:AutomaticAllocation>
        <rasd:Connection>bridged</rasd:Connection>
        <rasd:Description>E1000 ethernet adapter on "bridged"</rasd:Description>
        <rasd:ElementName>Network adapter 1</rasd:ElementName>
        <rasd:InstanceID>5</rasd:InstanceID>
        <rasd:ResourceSubType>E1000</rasd:ResourceSubType>
        <rasd:ResourceType>10</rasd:ResourceType>
      </Item>
    </VirtualHardwareSection>
    <AnnotationSection>
      <Info>A human-readable annotation</Info>
      <Annotation>MikrotikLover RADIUS server. Start it: the first boot sets up this VM's own passwords and certificates; the console shows the dashboard address and the first login.</Annotation>
    </AnnotationSection>
  </VirtualSystem>
</Envelope>
'''


if __name__ == "__main__":
    if len(sys.argv) != 4 or not sys.argv[3].isdigit():
        sys.exit(__doc__)
    print(ovf(sys.argv[1], sys.argv[2], int(sys.argv[3])), end="")

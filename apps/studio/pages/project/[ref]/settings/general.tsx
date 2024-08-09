import { IS_PLATFORM } from 'common'
import {
  CustomDomainConfig,
  DeleteProjectPanel,
  General,
  TransferProjectPanel,
} from 'components/interfaces/Settings/General'
import { useProjectContext } from 'components/layouts/ProjectLayout/ProjectContext'
import SettingsLayout from 'components/layouts/ProjectSettingsLayout/SettingsLayout'
import { ScaffoldContainer, ScaffoldHeader, ScaffoldTitle } from 'components/layouts/Scaffold'
import { useIsFeatureEnabled } from 'hooks/misc/useIsFeatureEnabled'
import { useRouter } from 'next/router'
import { useEffect } from 'react'
import type { NextPageWithLayout } from 'types'

const ProjectSettings: NextPageWithLayout = () => {
  const { project } = useProjectContext()
  const isBranch = !!project?.parent_project_ref
  const { projectsTransfer: projectTransferEnabled } = useIsFeatureEnabled(['projects:transfer'])
  const router = useRouter()

  useEffect(() => {
    if (!IS_PLATFORM) {
      router.push(`/project/default/settings/log-drains`)
    }
  }, [router])

  return (
    <>
      <ScaffoldContainer>
        <ScaffoldHeader>
          <ScaffoldTitle>Project Settings</ScaffoldTitle>
        </ScaffoldHeader>
      </ScaffoldContainer>
      <ScaffoldContainer className="flex flex-col gap-10" bottomPadding>
        <General />
        {!isBranch ? (
          <>
            <CustomDomainConfig />
            {projectTransferEnabled && <TransferProjectPanel />}
            <DeleteProjectPanel />
          </>
        ) : null}
      </ScaffoldContainer>
    </>
  )
}

ProjectSettings.getLayout = (page) => <SettingsLayout title="General">{page}</SettingsLayout>
export default ProjectSettings

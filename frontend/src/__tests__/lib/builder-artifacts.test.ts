import { describe, expect, it } from 'vitest';

import {
  getSessionBuilderFileItems,
  isIgnorableBuilderArtifactPath,
  pickBuilderPillLibraryItem,
} from '../../app/lib/builder-artifacts';

describe('builder-artifacts helpers', () => {
  it('ignores internal __pycache__ artifacts', () => {
    expect(
      isIgnorableBuilderArtifactPath('mnt/user-data/outputs/__pycache__/pear_data.cpython-312.pyc'),
    ).toBe(true);
    expect(
      isIgnorableBuilderArtifactPath('mnt/user-data/outputs/Pear_Field_Guide_Refresh_E2E.pdf'),
    ).toBe(false);
  });

  it('prefers the builder primary artifact over newer auxiliary files', () => {
    const selected = pickBuilderPillLibraryItem(
      [
        {
          path: 'mnt/user-data/outputs/__pycache__/pear_data.cpython-312.pyc',
          name: 'pear_data.cpython-312.pyc',
        },
        {
          path: 'mnt/user-data/outputs/Pear_Field_Guide_Refresh_E2E.pdf',
          name: 'Pear_Field_Guide_Refresh_E2E.pdf',
        },
      ],
      {
        artifactPath: 'mnt/user-data/outputs/Pear_Field_Guide_Refresh_E2E.pdf',
        artifactTitle: 'Pear Field Guide Refresh E2E',
        artifactType: 'document',
        decisionsMade: [],
      },
    );

    expect(selected).toMatchObject({
      path: 'mnt/user-data/outputs/Pear_Field_Guide_Refresh_E2E.pdf',
      name: 'Pear_Field_Guide_Refresh_E2E.pdf',
    });
  });

  it('drops ignored internal files from the session file list', () => {
    const items = getSessionBuilderFileItems(
      [
        {
          path: 'mnt/user-data/outputs/__pycache__/pear_data.cpython-312.pyc',
          name: 'pear_data.cpython-312.pyc',
        },
        {
          path: 'mnt/user-data/outputs/Pear_Field_Guide_Refresh_E2E.pdf',
          name: 'Pear_Field_Guide_Refresh_E2E.pdf',
        },
      ],
      {
        artifactPath: 'mnt/user-data/outputs/Pear_Field_Guide_Refresh_E2E.pdf',
        artifactTitle: 'Pear Field Guide Refresh E2E',
        artifactType: 'document',
        decisionsMade: [],
        supportingFiles: ['mnt/user-data/outputs/_generate_pear_field_guide.py'],
      },
    );

    expect(items.map((item) => item.path)).toEqual([
      'mnt/user-data/outputs/Pear_Field_Guide_Refresh_E2E.pdf',
      'mnt/user-data/outputs/_generate_pear_field_guide.py',
    ]);
  });
});